import type { RequestHandler } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';
import type { IShowcaseRepository, ShowcaseLimits, ShowcaseSourceRequest } from '@/modules/showcases/domain/showcase-types';
import type { BuildShowcasePreviewUseCase, PublishShowcaseUseCase } from '@/modules/showcases/use-cases/showcase-use-cases';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const sourceRequestSchema = z.object({
  projectId: uuid,
  selection: z.object({
    taskIds: z.array(uuid).max(1000),
    factIds: z.array(uuid).max(1000),
    filePaths: z.array(z.string().min(1).max(2048)).max(100)
  }).strict()
}).strict();
const publishRequestSchema = sourceRequestSchema.extend({
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  sourceRevision: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict();

export interface ShowcaseRouterDependencies {
  readonly repository: IShowcaseRepository;
  readonly buildPreview: BuildShowcasePreviewUseCase;
  readonly publish: PublishShowcaseUseCase;
  readonly getSession: Pick<GetSessionUseCase, 'execute'>;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Parameters<RequestHandler>[1]) => void;
  readonly limits?: ShowcaseLimits;
  readonly admissionConfigurationReady?: () => boolean;
  readonly managedStorageReady: () => Promise<boolean>;
}

function invalid(): AppError { return new AppError('VALIDATION_ERROR', 400, 'The showcase request is invalid.'); }

function parseSourceRequest(body: unknown): ShowcaseSourceRequest {
  const result = sourceRequestSchema.safeParse(body);
  if (!result.success) throw invalid();
  return result.data;
}

function requireAdmin(request: Parameters<RequestHandler>[0]): string {
  const principal = request.auth?.principal;
  if (!principal || principal.accountKind !== 'regular' || principal.role !== 'admin') {
    throw new AppError('ADMIN_REQUIRED', 403, 'An administrator session is required.');
  }
  return principal.id;
}

function asyncHandler(action: (request: Parameters<RequestHandler>[0], response: Parameters<RequestHandler>[1]) => Promise<void>): RequestHandler {
  return (request, response, next): void => { void action(request, response).catch(next); };
}

export function createShowcaseRouter(dependencies: ShowcaseRouterDependencies): Router {
  const router = Router();
  const authenticated = authenticateRequest(dependencies.getSession as GetSessionUseCase, dependencies.clearSessionCookie);

  router.get('/demo/availability', asyncHandler(async (_request, response) => {
    if (!dependencies.limits || (dependencies.admissionConfigurationReady && !dependencies.admissionConfigurationReady())) {
      sendData(response, { available: false });
      return;
    }
    const current = await dependencies.repository.getCurrentSummary();
    const available = Boolean(current) && (current?.fileCount === 0 || await dependencies.managedStorageReady());
    sendData(response, { available });
  }));

  router.get('/showcases/current', asyncHandler(async (_request, response) => {
    const current = await dependencies.repository.getCurrent();
    if (!current) throw new AppError('SHOWCASE_NOT_PUBLISHED', 404, 'No showcase is currently published.');
    response.setHeader('Cache-Control', 'no-store');
    sendData(response, current);
  }));

  router.get('/showcases/current/files/:fileId', asyncHandler(async (request, response) => {
    const fileId = uuid.safeParse(request.params.fileId);
    if (!fileId.success) throw new AppError('SHOWCASE_FILE_NOT_FOUND', 404, 'The requested file is not part of the current showcase.');
    const current = await dependencies.repository.getCurrentFile(fileId.data);
    if (!current) throw new AppError('SHOWCASE_FILE_NOT_FOUND', 404, 'The requested file is not part of the current showcase.');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', current.file.mediaType);
    response.setHeader('Content-Length', String(current.file.byteLength));
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(current.file.name)}`);
    response.status(200).send(current.bytes);
  }));

  router.post('/admin/showcases/previews', sameOrigin(dependencies.appOrigin), authenticated, requireCsrf, asyncHandler(async (request, response) => {
    const adminId = requireAdmin(request);
    const preview = await dependencies.buildPreview.execute(adminId, parseSourceRequest(request.body));
    sendData(response, preview);
  }));

  router.post('/admin/showcases/versions', sameOrigin(dependencies.appOrigin), authenticated, requireCsrf, asyncHandler(async (request, response) => {
    const adminId = requireAdmin(request);
    const parsed = publishRequestSchema.safeParse(request.body);
    const idempotencyKey = request.header('idempotency-key');
    if (!parsed.success || !idempotencyKey || !/^[A-Za-z0-9._:-]{1,128}$/u.test(idempotencyKey)) throw invalid();
    const { previewDigest, sourceRevision, ...source } = parsed.data;
    const outcome = await dependencies.publish.execute({
      adminId,
      request: source,
      previewDigest,
      sourceRevision,
      idempotencyKey
    });
    sendData(response, outcome.published, outcome.statusCode);
  }));

  return router;
}
