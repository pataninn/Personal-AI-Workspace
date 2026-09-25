import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { ProjectFactNotFoundError, ProjectFactVersionRequiredError } from '@/modules/memory/domain/project-fact-errors';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import type { CreateProjectFactUseCase } from '@/modules/memory/use-cases/create-project-fact';
import type { DeleteProjectFactUseCase } from '@/modules/memory/use-cases/delete-project-fact';
import type { ListProjectFactsUseCase } from '@/modules/memory/use-cases/list-project-facts';
import type { ReviewProjectFactUseCase } from '@/modules/memory/use-cases/review-project-fact';
import type { UpdateProjectFactUseCase } from '@/modules/memory/use-cases/update-project-fact';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const createSchema = z.object({ title: z.string(), content: z.string() }).strict();
const updateSchema = z.object({ title: z.string(), content: z.string(), expectedVersion: z.number().int().positive() }).strict();
const versionSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ProjectFactRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly listFacts: ListProjectFactsUseCase;
  readonly createFact: CreateProjectFactUseCase;
  readonly updateFact: UpdateProjectFactUseCase;
  readonly reviewFact: ReviewProjectFactUseCase;
  readonly deleteFact: DeleteProjectFactUseCase;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function parseId(value: string, error: Error): string {
  if (!UUID_PATTERN.test(value)) {
    throw error;
  }
  return value;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The project fact request is invalid.', result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request',
      message: issue.message
    })));
  }
  return result.data;
}

function parseIfMatch(value: string | undefined): number {
  const match = value?.match(/^"([1-9]\d*)"$/u);
  const version = match?.[1] ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ProjectFactVersionRequiredError();
  }
  return version;
}

function serializeFact(fact: ProjectFact): Record<string, unknown> {
  return {
    id: fact.id,
    projectId: fact.projectId,
    title: fact.title,
    content: fact.content,
    source: fact.source,
    version: fact.version,
    verifiedAt: fact.verifiedAt?.toISOString() ?? null,
    verificationStatus: fact.verificationStatus,
    createdAt: fact.createdAt.toISOString(),
    updatedAt: fact.updatedAt.toISOString()
  };
}

function listHandler(dependencies: ProjectFactRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projectId = parseId(routeParam(request.params.projectId), new ProjectFactNotFoundError());
      const facts = await dependencies.listFacts.execute({ ownerId, projectId });
      sendData(response, { facts: facts.map(serializeFact) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function createHandler(dependencies: ProjectFactRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projectId = parseId(routeParam(request.params.projectId), new ProjectFactNotFoundError());
      const fact = await dependencies.createFact.execute({ ownerId, projectId, ...parseBody(createSchema, request.body) });
      response.location(`/api/v1/projects/${projectId}/facts/${fact.id}`);
      sendData(response, { fact: serializeFact(fact) }, 201);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function updateHandler(dependencies: ProjectFactRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projectId = parseId(routeParam(request.params.projectId), new ProjectFactNotFoundError());
      const factId = parseId(routeParam(request.params.factId), new ProjectFactNotFoundError());
      const fact = await dependencies.updateFact.execute({ ownerId, projectId, factId, ...parseBody(updateSchema, request.body) });
      sendData(response, { fact: serializeFact(fact) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function reviewHandler(dependencies: ProjectFactRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projectId = parseId(routeParam(request.params.projectId), new ProjectFactNotFoundError());
      const factId = parseId(routeParam(request.params.factId), new ProjectFactNotFoundError());
      const fact = await dependencies.reviewFact.execute({ ownerId, projectId, factId, ...parseBody(versionSchema, request.body) });
      sendData(response, { fact: serializeFact(fact) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function deleteHandler(dependencies: ProjectFactRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projectId = parseId(routeParam(request.params.projectId), new ProjectFactNotFoundError());
      const factId = parseId(routeParam(request.params.factId), new ProjectFactNotFoundError());
      await dependencies.deleteFact.execute({ ownerId, projectId, factId, expectedVersion: parseIfMatch(request.header('if-match')) });
      response.status(204).end();
    } catch (error: unknown) {
      next(error);
    }
  };
}

export function createProjectFactRouter(dependencies: ProjectFactRouterDependencies): Router {
  const router = Router({ mergeParams: true });
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  router.get('/', authenticate, listHandler(dependencies));
  router.post('/', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, createHandler(dependencies));
  router.patch('/:factId', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, updateHandler(dependencies));
  router.post('/:factId/verification', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, reviewHandler(dependencies));
  router.delete('/:factId', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, deleteHandler(dependencies));
  return router;
}
