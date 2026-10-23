import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { AdminPortalUseCases } from '@/modules/admin-portal/use-cases/admin-portal-use-cases';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
const nullableDecimal = z.string().regex(/^(0|[1-9][0-9]*)$/u).nullable();
const limitsSchema = z.object({
  expectedRevision: z.number().int().positive(), dailyCreditLimitUnits: nullableDecimal,
  lifetimeCreditLimitUnits: nullableDecimal, storageLimitBytes: nullableDecimal
}).strict();
const settingsSchema = z.object({
  expectedRevision: z.number().int().positive(), defaultDailyLimitUnits: nullableDecimal, defaultLifetimeLimitUnits: nullableDecimal,
  sessionTtlHours: z.number().int().nullable(), globalAdmissionMax: z.number().int().nullable(),
  globalAdmissionWindowSeconds: z.number().int().nullable(), networkAdmissionMax: z.number().int().nullable(),
  networkAdmissionWindowSeconds: z.number().int().nullable(), runStartMax: z.number().int().nullable(),
  runStartWindowSeconds: z.number().int().nullable(), maxConcurrentCalls: z.number().int(), globalDailyLimitUnits: nullableDecimal,
  campaignId: z.string().max(128).nullable(), campaignLimitUnits: nullableDecimal, inferencePaused: z.boolean()
}).strict();

export interface AdminPortalRouterDependencies {
  readonly portal: AdminPortalUseCases;
  readonly getSession: GetSessionUseCase;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function invalid(): AppError { return new AppError('VALIDATION_ERROR', 400, 'The admin request is invalid.'); }

function requireAdmin(request: Parameters<RequestHandler>[0]): string {
  const principal = request.auth?.principal;
  if (!principal || principal.accountKind !== 'regular' || principal.role !== 'admin') {
    throw new AppError('ADMIN_REQUIRED', 403, 'An administrator session is required.');
  }
  return principal.id;
}

function ownerId(request: Parameters<RequestHandler>[0]): string {
  const id = request.auth?.principal.id;
  if (!id) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
  return id;
}

function asyncHandler(action: (request: Parameters<RequestHandler>[0], response: Response) => Promise<void>): RequestHandler {
  return (request, response, next): void => { void action(request, response).catch(next); };
}

export function createAdminPortalRouter(dependencies: AdminPortalRouterDependencies): Router {
  const router = Router();
  const authenticated = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  const writes = [sameOrigin(dependencies.appOrigin), authenticated, requireCsrf] as const;

  router.get('/account/usage', authenticated, asyncHandler(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    sendData(response, await dependencies.portal.getUsage(ownerId(request)));
  }));

  router.get('/admin/accounts', authenticated, asyncHandler(async (request, response) => {
    requireAdmin(request);
    response.setHeader('Cache-Control', 'no-store');
    const search = typeof request.query.search === 'string' ? request.query.search : '';
    sendData(response, await dependencies.portal.listAccounts(search));
  }));
  router.post('/admin/accounts', ...writes, asyncHandler(async (request) => {
    requireAdmin(request);
    throw new AppError('ACCOUNT_CREATION_RETIRED', 410, 'This workspace uses one owner account. Visitors can use the anonymous demo.');
  }));
  router.patch('/admin/accounts/:accountId/limits', ...writes, asyncHandler(async (request, response) => {
    const accountId = uuid.safeParse(request.params.accountId);
    const parsed = limitsSchema.safeParse(request.body);
    if (!accountId.success || !parsed.success) throw invalid();
    sendData(response, await dependencies.portal.updateAccountLimits(requireAdmin(request), accountId.data, parsed.data));
  }));
  router.patch('/admin/accounts/:accountId/status', ...writes, asyncHandler(async (request, response) => {
    const accountId = uuid.safeParse(request.params.accountId);
    const body = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
    if (!accountId.success || !body.success) throw invalid();
    sendData(response, await dependencies.portal.setAccountEnabled(requireAdmin(request), accountId.data, body.data.enabled));
  }));
  router.post('/admin/accounts/:accountId/password-resets', ...writes, asyncHandler(async (request, response) => {
    const accountId = uuid.safeParse(request.params.accountId);
    const body = z.object({ password: z.string().max(1024) }).strict().safeParse(request.body);
    if (!accountId.success || !body.success) throw invalid();
    await dependencies.portal.resetPassword(requireAdmin(request), accountId.data, body.data.password);
    sendData(response, { reset: true, sessionsRevoked: true });
  }));
  router.post('/admin/accounts/:accountId/session-revocations', ...writes, asyncHandler(async (request, response) => {
    const accountId = uuid.safeParse(request.params.accountId);
    const body = z.object({}).strict().safeParse(request.body);
    if (!accountId.success || !body.success) throw invalid();
    await dependencies.portal.revokeSessions(requireAdmin(request), accountId.data);
    sendData(response, { sessionsRevoked: true });
  }));
  router.get('/admin/demo-settings', authenticated, asyncHandler(async (request, response) => {
    requireAdmin(request);
    response.setHeader('Cache-Control', 'no-store');
    sendData(response, await dependencies.portal.getDemoSettings());
  }));
  router.put('/admin/demo-settings', ...writes, asyncHandler(async (request, response) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) throw invalid();
    sendData(response, await dependencies.portal.updateDemoSettings(requireAdmin(request), parsed.data));
  }));
  router.get('/admin/audit', authenticated, asyncHandler(async (request, response) => {
    requireAdmin(request);
    response.setHeader('Cache-Control', 'no-store');
    const limitValue = request.query.limit === undefined ? 40 : Number(request.query.limit);
    sendData(response, await dependencies.portal.listAudit(limitValue));
  }));
  return router;
}
