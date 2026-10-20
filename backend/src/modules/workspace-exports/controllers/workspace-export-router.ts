import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import type { CreateWorkspaceExportUseCase } from '@/modules/workspace-exports/use-cases/create-workspace-export';
import type { DownloadWorkspaceExportUseCase } from '@/modules/workspace-exports/use-cases/download-workspace-export';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const createSchema = z.object({ workspaceId: z.string().regex(UUID_PATTERN) }).strict();

export interface WorkspaceExportRouterDependencies {
  readonly create: CreateWorkspaceExportUseCase;
  readonly download: DownloadWorkspaceExportUseCase;
  readonly getSession: GetSessionUseCase;
  readonly clearSessionCookie: (response: Response) => void;
  readonly appOrigin: string;
}

export function createWorkspaceExportRouter(dependencies: WorkspaceExportRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);

  router.post('/', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, handler(async (request, response) => {
    if (!request.is('application/json')) throw validationError();
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw validationError();
    const idempotencyKey = request.header('idempotency-key');
    if (!idempotencyKey || !/^[A-Za-z0-9._~-]{8,128}$/u.test(idempotencyKey)) throw validationError();
    const ownerId = authenticatedOwnerId(request);
    const result = await dependencies.create.execute({ ownerId, workspaceId: parsed.data.workspaceId, idempotencyKey });
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    sendData(response, { export: result.descriptor }, result.replayed ? 200 : 201);
  }));

  router.get('/:exportId', authenticate, handler(async (request, response) => {
    const exportId = request.params.exportId ?? '';
    if (typeof exportId !== 'string' || !UUID_PATTERN.test(exportId)) throw unavailable();
    const result = await dependencies.download.execute(authenticatedOwnerId(request), exportId);
    response.status(200);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="workspace-export-${result.descriptor.id}.json"`);
    response.setHeader('Content-Length', String(result.bytes.byteLength));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(result.bytes);
  }));

  return router;
}

function handler(action: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try { await action(request, response); } catch (error: unknown) { next(error); }
  };
}

function authenticatedOwnerId(request: Request): string {
  const id = request.auth?.principal.id;
  if (!id) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
  return id;
}

function validationError(): AppError { return new AppError('VALIDATION_ERROR', 400, 'The workspace export request is invalid.'); }
function unavailable(): AppError { return new AppError('WORKSPACE_EXPORT_UNAVAILABLE', 404, 'The workspace export is unavailable.'); }
