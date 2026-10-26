import request from 'supertest';

import { createApp } from '@/app';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { GetReadinessUseCase } from '@/modules/health';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import type { AuthSessionSnapshot, LocalPrincipal } from '@/modules/auth/domain/auth-types';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import type { DemoAdmissionRouterDependencies } from '@/modules/demo/controllers/demo-admission-router';
import type { DemoShowcaseCopyDto } from '@/modules/demo/domain/demo-showcase-copy-types';
import type { Project } from '@/modules/projects/domain/project-types';
import type { ProjectRouterDependencies } from '@/modules/projects/controllers/project-router';
import type { ShowcaseRouterDependencies } from '@/modules/showcases/controllers/showcase-router';
import { createLogger } from '@/shared/logging/logger';

const DEMO_TOKEN = 'demo-session-token-with-at-least-32-characters';
const REGULAR_TOKEN = 'regular-session-token-with-at-least-32-characters';
const DEMO_ID = 'd3440000-0000-4000-8000-000000000001';
const REGULAR_ID = 'd3440000-0000-4000-8000-000000000002';
const PROJECT_ID = 'd3440000-0000-4000-8000-000000000003';
const SESSION_COOKIE = '__Host-pa_session';
const APP_ORIGIN = 'https://demo.example.test';
const NOW = new Date('2026-10-19T12:00:00.000Z');

const demoPrincipal: LocalPrincipal = {
  id: DEMO_ID,
  displayName: 'Demo workspace',
  accountKind: 'demo',
  role: 'user'
};
const regularPrincipal: LocalPrincipal = {
  id: REGULAR_ID,
  displayName: 'Local owner',
  accountKind: 'regular',
  role: 'admin'
};

function snapshot(principal: LocalPrincipal): AuthSessionSnapshot {
  return {
    sessionId: 'd3440000-0000-4000-8000-000000000010',
    principal,
    csrfToken: 'fixture-csrf-token',
    expiresAt: new Date('2026-10-20T12:00:00.000Z')
  };
}

function project(ownerId: string, projectId: string): Project {
  return {
    id: projectId,
    ownerId,
    name: 'Private project fixture',
    slug: 'private-project-fixture',
    relativeRoot: null,
    storageKind: null,
    objective: null,
    status: 'active',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function buildApp(ready: (ownerId: string) => Promise<boolean>) {
  const sessions = new Map([
    [DEMO_TOKEN, snapshot(demoPrincipal)],
    [REGULAR_TOKEN, snapshot(regularPrincipal)]
  ]);
  const getSession = {
    execute: jest.fn(async (rawToken: string | undefined) => {
      const session = rawToken ? sessions.get(rawToken) : undefined;
      if (!session) throw new UnauthenticatedError();
      return session;
    })
  } as unknown as Pick<GetSessionUseCase, 'execute'>;
  const privateHandler = jest.fn(async ({ ownerId, projectId }: { readonly ownerId: string; readonly projectId: string }) => project(ownerId, projectId));
  const copyStatus: DemoShowcaseCopyDto = {
    state: 'pending',
    projectId: null,
    retryAllowed: true,
    workspaceMode: null,
    capabilities: null
  };
  const getCopyStatus = jest.fn(async () => copyStatus);
  const createDemoSession = jest.fn(async () => ({ kind: 'status' as const, state: 'pending' as const }));
  const currentShowcase = {
    version: 'd3440000-0000-4000-8000-000000000020',
    publishedAt: NOW.toISOString(),
    project: { name: 'Public fixture', objective: null },
    tasks: [],
    facts: [],
    files: []
  };
  const getPublicShowcase = jest.fn(async () => currentShowcase);
  const readiness = new InMemoryReadinessState();
  readiness.markReady();

  const app = createApp({
    logger: createLogger('silent'),
    readiness: new GetReadinessUseCase(readiness),
    appVersion: 'test',
    demoCopyGate: { getSession, isReady: ready },
    projects: {
      getSession,
      getProject: { execute: privateHandler },
      appOrigin: APP_ORIGIN,
      clearSessionCookie: () => undefined
    } as unknown as ProjectRouterDependencies,
    demoAdmission: {
      createSession: { execute: createDemoSession },
      getSession,
      appOrigin: APP_ORIGIN,
      cookieSecure: false,
      showcaseCopy: {
        getStatus: getCopyStatus,
        retry: async () => copyStatus
      }
    } satisfies DemoAdmissionRouterDependencies,
    showcases: {
      repository: {
        getCurrent: getPublicShowcase,
        getCurrentSummary: async () => null,
        getCurrentFile: async () => null
      },
      buildPreview: { execute: jest.fn() },
      publish: { execute: jest.fn() },
      getSession,
      appOrigin: APP_ORIGIN,
      clearSessionCookie: () => undefined,
      managedStorageReady: async () => true
    } as unknown as ShowcaseRouterDependencies
  });

  return { app, privateHandler, getCopyStatus, getPublicShowcase, createDemoSession };
}

function cookie(token: string): { Cookie: string } {
  return { Cookie: `${SESSION_COOKIE}=${token}` };
}

describe('demo copy gate HTTP boundary', () => {
  it('does not expire browser cookies on rejected copy reads/retries or pending/failed admission responses', async () => {
    const { app, createDemoSession } = buildApp(async () => true);
    const invalidCookie = cookie('invalid-old-session-token-with-at-least-32-characters');
    const read = await request(app).get('/api/v1/demo/showcase-copy').set(invalidCookie).expect(401);
    const retry = await request(app).post('/api/v1/demo/showcase-copy/retries').set(invalidCookie)
      .set('Origin', APP_ORIGIN).send({}).expect(401);
    const pending = await request(app).post('/api/v1/demo/session').set(invalidCookie)
      .set('Origin', APP_ORIGIN).set('Idempotency-Key', Buffer.alloc(32, 1).toString('base64url')).send({}).expect(202);
    createDemoSession.mockRejectedValueOnce(new Error('Admission temporarily unavailable.'));
    const failed = await request(app).post('/api/v1/demo/session').set(invalidCookie)
      .set('Origin', APP_ORIGIN).set('Idempotency-Key', Buffer.alloc(32, 2).toString('base64url')).send({}).expect(500);
    for (const response of [read, retry, pending, failed]) expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('denies an unready demo before the attached private project handler runs', async () => {
    const isReady = jest.fn(async () => false);
    const { app, privateHandler } = buildApp(isReady);

    const response = await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}`)
      .set(cookie(DEMO_TOKEN));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEMO_COPY_NOT_READY');
    expect(privateHandler).not.toHaveBeenCalled();
    expect(isReady).toHaveBeenCalledTimes(1);
    expect(isReady).toHaveBeenCalledWith(DEMO_ID);
  });

  it('allows a ready demo and a regular session through to the private handler', async () => {
    const isReady = jest.fn(async (ownerId: string) => ownerId === DEMO_ID);
    const { app, privateHandler } = buildApp(isReady);

    const demoResponse = await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}`)
      .set(cookie(DEMO_TOKEN));
    const regularResponse = await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}`)
      .set(cookie(REGULAR_TOKEN));

    expect(demoResponse.status).toBe(200);
    expect(demoResponse.body.data.id).toBe(PROJECT_ID);
    expect(regularResponse.status).toBe(200);
    expect(privateHandler).toHaveBeenCalledTimes(2);
    expect(isReady).toHaveBeenCalledTimes(1);
    expect(isReady).toHaveBeenCalledWith(DEMO_ID);
  });

  it('preserves copy status and public snapshot reads for an unready demo', async () => {
    const isReady = jest.fn(async () => false);
    const { app, getCopyStatus, getPublicShowcase } = buildApp(isReady);

    const copyResponse = await request(app)
      .get('/api/v1/demo/showcase-copy')
      .set(cookie(DEMO_TOKEN));
    const publicResponse = await request(app)
      .get('/api/v1/showcases/current')
      .set(cookie(DEMO_TOKEN));

    expect(copyResponse.status).toBe(202);
    expect(copyResponse.body.data).toMatchObject({ state: 'pending', projectId: null });
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.body.data.project.name).toBe('Public fixture');
    expect(getCopyStatus).toHaveBeenCalledWith(DEMO_ID);
    expect(getPublicShowcase).toHaveBeenCalledTimes(1);
    expect(isReady).not.toHaveBeenCalled();
  });
});
