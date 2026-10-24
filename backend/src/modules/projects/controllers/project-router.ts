import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import type { RenameProjectUseCase } from '@/modules/projects/use-cases/rename-project';

import { ProjectNotFoundError, ProjectVersionRequiredError } from '@/modules/projects/domain/project-errors';
import { projectWorkspaceMode, type Project } from '@/modules/projects/domain/project-types';
import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';
import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';
import { deleteProjectHandler, overviewHandler } from '@/modules/projects/controllers/project-overview-handlers';
import type { DeleteProjectUseCase } from '@/modules/projects/use-cases/delete-project';
import type { GetProjectOverviewUseCase } from '@/modules/projects/use-cases/get-project-overview';
import type {
  CreateProjectUseCase,
  GetProjectUseCase,
  ListProjectsUseCase,
  UpdateProjectStatusUseCase
} from '@/modules/projects/use-cases/project-use-cases';
import type { IWorkspacePlanningUseCases } from '@/modules/projects/use-cases/workspace-planning-use-cases';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';

const createProjectSchema = z.object({
  name: z.string().max(120),
  workspaceMode: z.enum(['planning', 'file_backed']).optional(),
  objective: z.string().max(2000).optional()
}).strict();

const updateProjectSchema = z.object({
  status: z.enum(['active', 'archived'])
}).strict();

const projectSearchSchema = z.object({
  query: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(20).optional()
}).strict();

const reuseProjectSchema = z.object({ projectId: z.string().uuid() }).strict();

const planningProjectSchema = z.object({
  name: z.string().max(120),
  objective: z.string().max(2000).nullable().optional()
}).strict();

const updateObjectiveSchema = z.object({ objective: z.string().max(2000).nullable() }).strict();

const attachRootSchema = z.object({}).strict();

export interface ProjectRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly renameProject?: RenameProjectUseCase;
  readonly createProject: CreateProjectUseCase;
  readonly listProjects: ListProjectsUseCase;
  readonly getProject: GetProjectUseCase;
  readonly updateProjectStatus: UpdateProjectStatusUseCase;
  readonly workspacePlanning: IWorkspacePlanningUseCases;
  readonly workspaceBoundary?: IWorkspaceBoundary;
  readonly deleteProject?: DeleteProjectUseCase;
  readonly getOverview?: GetProjectOverviewUseCase;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

type ProjectPlanningRouterDependencies = ProjectRouterDependencies & { readonly workspacePlanning: IWorkspacePlanningUseCases };

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The project request is invalid.', result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request',
      message: issue.message
    })));
  }
  return result.data;
}

function parseIncludeArchived(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new AppError('VALIDATION_ERROR', 400, 'The project query is invalid.', [{
    field: 'includeArchived',
    message: 'includeArchived must be true or false.'
  }]);
}

function parseProjectId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new ProjectNotFoundError();
  }
  return value;
}

function routeProjectId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function parseVersion(value: string | undefined): number {
  if (!value || !/^\d+$/u.test(value)) {
    throw new ProjectVersionRequiredError();
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ProjectVersionRequiredError();
  }
  return version;
}

async function serializeProject(project: Project, workspaceBoundary?: IWorkspaceBoundary): Promise<Record<string, unknown>> {
  let fileAccess = false;
  if (project.relativeRoot !== null && project.storageKind === 'legacy') {
    fileAccess = (await workspaceBoundary?.getSnapshot())?.status === 'ready';
  } else if (project.relativeRoot !== null && project.storageKind === 'managed') {
    fileAccess = (await workspaceBoundary?.getManagedSnapshot?.())?.status === 'ready';
  }
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    objective: project.objective,
    workspaceMode: projectWorkspaceMode(project),
    capabilities: { planning: true, fileAccess },
    status: project.status,
    version: project.version,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString()
  };
}

function serializeProjectAction(receipt: ActionLedgerRecord): Record<string, unknown> {
  return {
    id: receipt.id,
    actionKind: receipt.actionKind,
    targetId: receipt.targetId,
    preVersion: receipt.preVersion,
    postVersion: receipt.postVersion,
    undoStatus: receipt.undoStatus,
    createdAt: receipt.createdAt
  };
}

function projectSearchHandler(dependencies: ProjectPlanningRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const query = parseBody(projectSearchSchema, request.query);
      const result = await dependencies.workspacePlanning.search({ ownerId, query: query.query, limit: query.limit ?? 10 });
      sendData(response, {
        projects: result.projects.map((project) => ({
          id: project.id,
          name: project.name,
          objective: project.objective,
          workspaceMode: projectWorkspaceMode(project),
          status: project.status,
          version: project.version
        })),
        limit: result.limit,
        hasMore: result.hasMore,
        ambiguous: result.projects.length > 1 || result.hasMore
      });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function reuseProjectHandler(dependencies: ProjectPlanningRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const input = parseBody(reuseProjectSchema, request.body);
      const project = await dependencies.workspacePlanning.reuse({ ownerId, projectId: input.projectId });
      sendData(response, await serializeProject(project, dependencies.workspaceBoundary));
    } catch (error: unknown) {
      next(error);
    }
  };
}

function createPlanningProjectHandler(dependencies: ProjectPlanningRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const input = parseBody(planningProjectSchema, request.body);
      const result = await dependencies.workspacePlanning.createPlanning({
        ownerId,
        operationKey: request.header('idempotency-key'),
        name: input.name,
        ...(input.objective !== undefined ? { objective: input.objective } : {})
      });
      sendData(response, {
        project: await serializeProject(result.project, dependencies.workspaceBoundary),
        receipt: serializeProjectAction(result.receipt),
        replayed: result.replayed
      }, result.replayed ? 200 : 201);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function updateProjectObjectiveHandler(dependencies: ProjectPlanningRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const input = parseBody(updateObjectiveSchema, request.body);
      const result = await dependencies.workspacePlanning.updateObjective({
        ownerId,
        projectId: parseProjectId(routeProjectId(request.params.projectId)),
        expectedVersion: parseVersion(request.header('if-match')),
        operationKey: request.header('idempotency-key'),
        objective: input.objective
      });
      sendData(response, {
        project: await serializeProject(result.project, dependencies.workspaceBoundary),
        receipt: serializeProjectAction(result.receipt),
        replayed: result.replayed
      });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function attachInitialProjectRootHandler(dependencies: ProjectPlanningRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      parseBody(attachRootSchema, request.body);
      const result = await dependencies.workspacePlanning.attachInitialRoot({
        ownerId,
        projectId: parseProjectId(routeProjectId(request.params.projectId)),
        expectedVersion: parseVersion(request.header('if-match')),
        operationKey: request.header('idempotency-key')
      });
      sendData(response, {
        project: await serializeProject(result.project, dependencies.workspaceBoundary),
        receipt: serializeProjectAction(result.receipt),
        replayed: result.replayed
      });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function listHandler(dependencies: ProjectRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projects = await dependencies.listProjects.execute({
        ownerId,
        includeArchived: parseIncludeArchived(request.query.includeArchived)
      });
      sendData(response, { projects: await Promise.all(projects.map((project) => serializeProject(project, dependencies.workspaceBoundary))) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function createHandler(dependencies: ProjectRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const project = await dependencies.createProject.execute({ ownerId, ...parseBody(createProjectSchema, request.body) });
      sendData(response, await serializeProject(project, dependencies.workspaceBoundary), 201);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function getHandler(dependencies: ProjectRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const project = await dependencies.getProject.execute({ ownerId, projectId: parseProjectId(routeProjectId(request.params.projectId)) });
      sendData(response, await serializeProject(project, dependencies.workspaceBoundary));
    } catch (error: unknown) {
      next(error);
    }
  };
}

function updateStatusHandler(dependencies: ProjectRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const project = await dependencies.updateProjectStatus.execute({
        ownerId,
        projectId: parseProjectId(routeProjectId(request.params.projectId)),
        expectedVersion: parseVersion(request.header('if-match')),
        ...parseBody(updateProjectSchema, request.body)
      });
      sendData(response, await serializeProject(project, dependencies.workspaceBoundary));
    } catch (error: unknown) {
      next(error);
    }
  };
}

export function createProjectRouter(dependencies: ProjectRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  router.get('/', authenticate, listHandler(dependencies));
  router.post('/', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, createHandler(dependencies));
  router.get('/search', authenticate, projectSearchHandler(dependencies));
  router.post('/reuse', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, reuseProjectHandler(dependencies));
  router.post('/planning', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, createPlanningProjectHandler(dependencies));
  router.patch('/:projectId/objective', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, updateProjectObjectiveHandler(dependencies));
  if (dependencies.renameProject) router.patch('/:projectId/name', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, async (request, response, next) => {
    try {
      const body = parseBody(z.object({ name: z.string().max(120) }).strict(), request.body);
      const project = await dependencies.renameProject!.execute({
        ownerId: request.auth!.principal.id,
        projectId: parseProjectId(routeProjectId(request.params.projectId)),
        expectedVersion: parseVersion(request.header('if-match')),
        name: body.name
      });
      sendData(response, await serializeProject(project, dependencies.workspaceBoundary));
    } catch (error: unknown) { next(error); }
  });
  router.patch('/:projectId/root-attachment', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, attachInitialProjectRootHandler(dependencies));
  router.get('/overview', authenticate, overviewHandler(dependencies));
  router.get('/:projectId', authenticate, getHandler(dependencies));
  router.patch('/:projectId', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, updateStatusHandler(dependencies));
  router.delete('/:projectId', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, deleteProjectHandler(dependencies));
  return router;
}
