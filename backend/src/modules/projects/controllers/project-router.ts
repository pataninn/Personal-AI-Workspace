import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { ProjectNotFoundError, ProjectVersionRequiredError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';
import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';
import type {
  CreateProjectUseCase,
  GetProjectUseCase,
  ListProjectsUseCase,
  UpdateProjectStatusUseCase
} from '@/modules/projects/use-cases/project-use-cases';

const createProjectSchema = z.object({
  name: z.string().max(120),
  relativeRoot: z.string().max(2048)
}).strict();

const updateProjectSchema = z.object({
  status: z.enum(['active', 'archived'])
}).strict();

export interface ProjectRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly createProject: CreateProjectUseCase;
  readonly listProjects: ListProjectsUseCase;
  readonly getProject: GetProjectUseCase;
  readonly updateProjectStatus: UpdateProjectStatusUseCase;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

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

function serializeProject(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    relativeRoot: project.relativeRoot,
    status: project.status,
    version: project.version,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString()
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
      sendData(response, { projects: projects.map(serializeProject) });
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
      sendData(response, serializeProject(project), 201);
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
      sendData(response, serializeProject(project));
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
      sendData(response, serializeProject(project));
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
  router.get('/:projectId', authenticate, getHandler(dependencies));
  router.patch('/:projectId', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, updateStatusHandler(dependencies));
  return router;
}
