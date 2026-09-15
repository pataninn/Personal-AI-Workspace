import type { Request, RequestHandler } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { WorkspacePathInvalidError } from '@/modules/files/domain/workspace-errors';
import type {
  ListWorkspaceFilesUseCase,
  ReadWorkspaceTextUseCase,
  SearchWorkspaceTextUseCase,
  TreeWorkspaceFilesUseCase
} from '@/modules/files/use-cases';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const directorySchema = z.string().max(2048).default('');
const pathSchema = z.string().min(1).max(2048);
const querySchema = z.string().min(1).max(256);

export interface WorkspaceRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly listWorkspaceFiles: ListWorkspaceFilesUseCase;
  readonly treeWorkspaceFiles: TreeWorkspaceFilesUseCase;
  readonly readWorkspaceText: ReadWorkspaceTextUseCase;
  readonly searchWorkspaceText: SearchWorkspaceTextUseCase;
  readonly clearSessionCookie: (response: Parameters<RequestHandler>[1]) => void;
}

function routeValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('VALIDATION_ERROR', 400, 'The workspace request is invalid.', [{ field, message: `${field} is required.` }]);
  }
  return value;
}

function optionalQuery(request: Request, field: string): unknown {
  const value = request.query[field];
  if (Array.isArray(value)) {
    throw new AppError('VALIDATION_ERROR', 400, 'The workspace query is invalid.', [{ field, message: `${field} must be supplied once.` }]);
  }
  return value;
}

function parseDirectory(request: Request): string {
  const value = optionalQuery(request, 'directory');
  const result = directorySchema.safeParse(value ?? '');
  if (!result.success) {
    throw new WorkspacePathInvalidError('directory');
  }
  return result.data;
}

function parsePath(request: Request): string {
  const value = optionalQuery(request, 'path');
  const result = pathSchema.safeParse(value);
  if (!result.success) {
    throw new WorkspacePathInvalidError('path');
  }
  return result.data;
}

function parseInteger(request: Request, field: string, defaultValue: number): number {
  const value = optionalQuery(request, field);
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    throw new AppError('VALIDATION_ERROR', 400, 'The workspace query is invalid.', [{ field, message: `${field} must be a whole number.` }]);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError('VALIDATION_ERROR', 400, 'The workspace query is invalid.', [{ field, message: `${field} is outside the safe range.` }]);
  }
  return parsed;
}

function parseQuery(request: Request): string {
  const result = querySchema.safeParse(optionalQuery(request, 'query'));
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The workspace query is invalid.', [{ field: 'query', message: 'query is required.' }]);
  }
  return result.data;
}

function parseProjectId(value: string | string[] | undefined): string {
  const projectId = Array.isArray(value) ? value[0] : value;
  if (!projectId || !UUID_PATTERN.test(projectId)) {
    throw new AppError('VALIDATION_ERROR', 400, 'The workspace request is invalid.', [{ field: 'projectId', message: 'projectId must be a UUID.' }]);
  }
  return projectId;
}

function withRequestSignal<T>(request: Request, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onClose = (): void => controller.abort();
  request.once('close', onClose);
  return action(controller.signal).finally(() => request.off('close', onClose));
}

function listHandler(dependencies: WorkspaceRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const result = await withRequestSignal(request, (signal) => dependencies.listWorkspaceFiles.execute({
        ownerId,
        projectId: parseProjectId(request.params.projectId),
        directory: parseDirectory(request),
        signal
      }));
      sendData(response, result);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function treeHandler(dependencies: WorkspaceRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const result = await withRequestSignal(request, (signal) => dependencies.treeWorkspaceFiles.execute({
        ownerId,
        projectId: parseProjectId(request.params.projectId),
        directory: parseDirectory(request),
        depth: parseInteger(request, 'depth', 2),
        signal
      }));
      sendData(response, result);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function readHandler(dependencies: WorkspaceRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const result = await withRequestSignal(request, (signal) => dependencies.readWorkspaceText.execute({
        ownerId,
        projectId: parseProjectId(request.params.projectId),
        path: parsePath(request),
        signal
      }));
      sendData(response, result);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function searchHandler(dependencies: WorkspaceRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const result = await withRequestSignal(request, (signal) => dependencies.searchWorkspaceText.execute({
        ownerId,
        projectId: parseProjectId(request.params.projectId),
        directory: parseDirectory(request),
        query: parseQuery(request),
        ...(optionalQuery(request, 'maxResults') === undefined ? {} : { maxResults: parseInteger(request, 'maxResults', 1) }),
        signal
      }));
      sendData(response, result);
    } catch (error: unknown) {
      next(error);
    }
  };
}

export function createWorkspaceRouter(dependencies: WorkspaceRouterDependencies): Router {
  const router = Router({ mergeParams: true });
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  router.get('/tree', authenticate, treeHandler(dependencies));
  router.get('/search', authenticate, searchHandler(dependencies));
  router.get('/content', authenticate, readHandler(dependencies));
  router.get('/', authenticate, listHandler(dependencies));
  return router;
}
