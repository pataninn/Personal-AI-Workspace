import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';

import { createAiRunRouter } from '@/modules/ai-runs/controllers/ai-run-router';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

function appWithActivity(): { readonly app: express.Express; readonly listActivity: jest.Mock; readonly getActivity: jest.Mock } {
  const listActivity = jest.fn(async () => ({ projectId: PROJECT_ID, items: [], nextCursor: null }));
  const getActivity = jest.fn(async () => ({ runId: RUN_ID, projectId: PROJECT_ID }));
  const app = express();
  app.use(cookieParser());
  app.use('/api/v1', createAiRunRouter({
    getSession: { execute: jest.fn(async () => ({ sessionId: 'session', principal: { id: OWNER_ID, displayName: 'Local user' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000) })) } as never,
    createAiRun: {} as never,
    getAiRun: {} as never,
    decideEgress: {} as never,
    listActivity: { execute: listActivity } as never,
    getActivity: { execute: getActivity } as never,
    appOrigin: 'https://127.0.0.1:8443',
    clearSessionCookie: () => undefined
  }));
  return { app, listActivity, getActivity };
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
});
