import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';

import { createAdminPortalRouter, type AdminPortalRouterDependencies } from '@/modules/admin-portal/controllers/admin-portal-router';
import { AppError } from '@/shared/errors/app-error';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://127.0.0.1:8443';
const RAW_PASSWORD = 'initial-secret-not-returned';

function buildApp(role: 'admin' | 'owner' = 'admin') {
  const portal = {
    listAccounts: jest.fn(async () => ({ accounts: [] })),
    getUsage: jest.fn(async () => ({ ownerId: ADMIN_ID })),
    createAccount: jest.fn(async () => ({ account: { id: ACCOUNT_ID, identifier: 'new_user' } })),
    updateAccountLimits: jest.fn(async () => ({})),
    setAccountEnabled: jest.fn(async () => ({})),
    resetPassword: jest.fn(async () => undefined),
    revokeSessions: jest.fn(async () => undefined),
    getDemoSettings: jest.fn(async () => ({})),
    updateDemoSettings: jest.fn(async () => ({})),
    listAudit: jest.fn(async () => ({ events: [] }))
  };
  const dependencies = {
    portal,
    getSession: { execute: jest.fn(async () => ({
      sessionId: 'session-id', principal: { id: ADMIN_ID, displayName: 'Local user', accountKind: 'regular', role },
      csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000)
    })) },
    appOrigin: ORIGIN,
    clearSessionCookie: jest.fn()
  } as unknown as AdminPortalRouterDependencies;
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1', createAdminPortalRouter(dependencies));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 500, 'Internal server error.');
    response.status(appError.statusCode).json({ data: null, error: { code: appError.code, message: appError.message } });
  });
  return { app, portal };
}

function mutationHeaders(): Record<string, string> {
  return { Cookie: '__Host-pa_session=session-token', Origin: ORIGIN, 'X-CSRF-Token': 'csrf-token' };
}

describe('admin portal routes', () => {
  it('denies a regular owner before calling admin operations', async () => {
    const { app, portal } = buildApp('owner');

    const result = await request(app).get('/api/v1/admin/accounts').set('Cookie', '__Host-pa_session=session-token');

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('ADMIN_REQUIRED');
    expect(portal.listAccounts).not.toHaveBeenCalled();
  });

  it('derives the usage owner from the authenticated session rather than request input', async () => {
    const { app, portal } = buildApp('owner');

    const result = await request(app).get('/api/v1/account/usage?ownerId=attacker')
      .set('Cookie', '__Host-pa_session=session-token');

    expect(result.status).toBe(200);
    expect(portal.getUsage).toHaveBeenCalledWith(ADMIN_ID);
    expect(result.body.data.ownerId).toBe(ADMIN_ID);
  });

  it('returns only a success marker for password reset and never echoes the submitted secret', async () => {
    const { app, portal } = buildApp();

    const create = await request(app).post('/api/v1/admin/accounts').set(mutationHeaders()).send({
      displayName: 'New user', identifier: 'new_user', password: RAW_PASSWORD
    });
    const reset = await request(app).post(`/api/v1/admin/accounts/${ACCOUNT_ID}/password-resets`)
      .set(mutationHeaders()).send({ password: RAW_PASSWORD });

    expect(create.status).toBe(201);
    expect(reset.status).toBe(200);
    expect(reset.body.data).toEqual({ reset: true, sessionsRevoked: true });
    expect(JSON.stringify({ create: create.body, reset: reset.body })).not.toContain(RAW_PASSWORD);
    expect(portal.createAccount).toHaveBeenCalledWith(ADMIN_ID, {
      displayName: 'New user', identifier: 'new_user', password: RAW_PASSWORD
    });
    expect(portal.resetPassword).toHaveBeenCalledWith(ADMIN_ID, ACCOUNT_ID, RAW_PASSWORD);
  });
});
