import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';

import { createAiRunRouter } from '@/modules/ai-runs/controllers/ai-run-router';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

function appWithActivity(includeFileHistory = true): { readonly app: express.Express; readonly listActivity: jest.Mock; readonly getActivity: jest.Mock; readonly listFileHistory: jest.Mock; readonly listProviderPermissions: jest.Mock; readonly revokeProviderPermission: jest.Mock } {
  const listActivity = jest.fn(async () => ({ projectId: PROJECT_ID, items: [], nextCursor: null }));
  const getActivity = jest.fn(async () => ({ runId: RUN_ID, projectId: PROJECT_ID }));
  const listFileHistory = jest.fn(async () => ({ projectId: PROJECT_ID, path: 'src/app.ts', outcome: 'all', items: [], nextCursor: null }));
  const listProviderPermissions = jest.fn(async () => []);
  const revokeProviderPermission = jest.fn(async () => ({ id: RUN_ID, ownerId: OWNER_ID, projectId: PROJECT_ID, providerProfile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b', capability: 'send_selected_context', createdAt: new Date(), expiresAt: null, revokedAt: new Date() }));
  const app = express();
  app.use(cookieParser());
  app.use('/api/v1', createAiRunRouter({
    getSession: { execute: jest.fn(async () => ({ sessionId: 'session', principal: { id: OWNER_ID, displayName: 'Local user' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000) })) } as never,
    createAiRun: {} as never,
    getAiRun: {} as never,
    decideEgress: {} as never,
    listActivity: { execute: listActivity } as never,
    getActivity: { execute: getActivity } as never,
    ...(includeFileHistory ? { listFileHistory: { execute: listFileHistory } as never } : {}),
    listProviderPermissions: { execute: listProviderPermissions } as never,
    revokeProviderPermission: { execute: revokeProviderPermission } as never,
    appOrigin: 'https://127.0.0.1:8443',
    clearSessionCookie: () => undefined
  }));
  return { app, listActivity, getActivity, listFileHistory, listProviderPermissions, revokeProviderPermission };
}

describe('AI run activity routes', () => {
  it('mounts the authenticated owner-scoped project history endpoint', async () => {
    const { app, listActivity } = appWithActivity();

    const response = await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}/ai-runs?filter=active&limit=10`)
      .set('Cookie', '__Host-pa_session=session-token');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ projectId: PROJECT_ID, items: [], nextCursor: null });
    expect(listActivity).toHaveBeenCalledWith({ ownerId: OWNER_ID, projectId: PROJECT_ID, limit: '10', cursor: undefined, filter: 'active' });
  });

  it('mounts the authenticated run activity detail endpoint', async () => {
    const { app, getActivity } = appWithActivity();

    const response = await request(app)
      .get(`/api/v1/ai-runs/${RUN_ID}/activity`)
      .set('Cookie', '__Host-pa_session=session-token');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ runId: RUN_ID, projectId: PROJECT_ID });
    expect(getActivity).toHaveBeenCalledWith({ ownerId: OWNER_ID, runId: RUN_ID });
  });

  it('mounts owner-scoped file history with explicit path and outcome filters', async () => {
    const { app, listFileHistory } = appWithActivity();
    const response = await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}/file-history?path=src%2Fapp.ts&outcome=applied&limit=10`)
      .set('Cookie', '__Host-pa_session=session-token');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ projectId: PROJECT_ID, path: 'src/app.ts', outcome: 'all' });
    expect(listFileHistory).toHaveBeenCalledWith({ ownerId: OWNER_ID, projectId: PROJECT_ID, path: 'src/app.ts', outcome: 'applied', limit: '10', cursor: undefined });
  });

  it('lists project permissions under the authenticated owner scope', async () => {
    const { app, listProviderPermissions } = appWithActivity();
    const response = await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}/provider-permissions`)
      .set('Cookie', '__Host-pa_session=session-token');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ permissions: [] });
    expect(listProviderPermissions).toHaveBeenCalledWith({ ownerId: OWNER_ID, projectId: PROJECT_ID });
  });

  it('mounts provider permission routes independently of the optional file history route', async () => {
    const { app, listProviderPermissions } = appWithActivity(false);
    const response = await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}/provider-permissions`)
      .set('Cookie', '__Host-pa_session=session-token');

    expect(response.status).toBe(200);
    expect(listProviderPermissions).toHaveBeenCalledWith({ ownerId: OWNER_ID, projectId: PROJECT_ID });
  });

  it('requires same-origin CSRF for a provider permission revocation', async () => {
    const { app, revokeProviderPermission } = appWithActivity();
    const url = `/api/v1/projects/${PROJECT_ID}/provider-permissions/${RUN_ID}`;
    const unauthorized = await request(app).delete(url).set('Cookie', '__Host-pa_session=session-token');
    expect(unauthorized.status).toBe(403);
    expect(revokeProviderPermission).not.toHaveBeenCalled();

    const response = await request(app)
      .delete(url)
      .set('Cookie', '__Host-pa_session=session-token')
      .set('Origin', 'https://127.0.0.1:8443')
      .set('X-CSRF-Token', 'csrf-token');

    expect(response.status).toBe(200);
    expect(revokeProviderPermission).toHaveBeenCalledWith({ ownerId: OWNER_ID, projectId: PROJECT_ID, permissionId: RUN_ID });
  });
});
