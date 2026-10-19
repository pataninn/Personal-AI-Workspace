import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import { GetReadinessUseCase } from '@/modules/health';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { createLogger } from '@/shared/logging/logger';
import type { AuthSessionSnapshot, LocalPrincipal } from '@/modules/auth/domain/auth-types';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import type { DemoAdmissionAttemptResult } from '@/modules/demo/domain/demo-admission-types';
import type { DemoAdmissionRouterDependencies } from '@/modules/demo/controllers/demo-admission-router';

const ORIGIN = 'https://demo.example.test';
const COOKIE = '__Host-pa_session';
const TOKEN = 'demo-session-token-with-at-least-32-characters';
const REGULAR_TOKEN = 'regular-session-token-with-at-least-32-characters';
const DEMO_ID = 'd3330000-0000-4000-8000-000000000001';
const REGULAR_ID = 'd3330000-0000-4000-8000-000000000002';
const DEMO_PRINCIPAL: LocalPrincipal = { id: DEMO_ID, displayName: 'Demo workspace', accountKind: 'demo', role: 'user' };
const REGULAR_PRINCIPAL: LocalPrincipal = { id: REGULAR_ID, displayName: 'Local owner', accountKind: 'regular', role: 'admin' };
const expiresAt = new Date('2026-10-20T12:00:00.000Z');

function snapshot(principal: LocalPrincipal, csrfToken: string): AuthSessionSnapshot {
  return { sessionId: 'd3330000-0000-4000-8000-000000000010', principal, csrfToken, expiresAt };
}

function dependencies(
  createResult: DemoAdmissionAttemptResult = { kind: 'status', state: 'pending' },
  sessions: Readonly<Record<string, AuthSessionSnapshot>> = {}
): DemoAdmissionRouterDependencies & { clientIps: string[] } {
  const clientIps: string[] = [];
  return {
    clientIps,
    createSession: {
      execute: jest.fn(async ({ clientIp }) => {
        if (clientIp) clientIps.push(clientIp);
        return createResult;
      })
    },
    getSession: {
      execute: jest.fn(async (rawToken: string | undefined) => {
        const value = rawToken ? sessions[rawToken] : undefined;
        if (!value) throw new UnauthenticatedError();
        return value;
      })
    } as DemoAdmissionRouterDependencies['getSession'],
    appOrigin: ORIGIN,
    cookieSecure: true
  };
}

function appWith(deps: DemoAdmissionRouterDependencies, trustedProxyCidrs?: readonly string[]) {
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  return createApp({
    logger: createLogger('silent'),
    readiness: new GetReadinessUseCase(readiness),
    appVersion: 'test',
    demoAdmission: deps,
    ...(trustedProxyCidrs ? { trustedProxyCidrs } : {})
  });
}

function anonymousPost(app: express.Express) {
  return request(app).post('/api/v1/demo/session')
    .set('Origin', ORIGIN)
    .set('Idempotency-Key', Buffer.alloc(32, 1).toString('base64url'))
    .send({});
}

describe('demo admission HTTP boundary', () => {
  it('resumes a valid demo session without a new admission, cookie, or expiry extension', async () => {
    const deps = dependencies({ kind: 'status', state: 'ready' }, { [TOKEN]: snapshot(DEMO_PRINCIPAL, 'demo-csrf') });
    const response = await request(appWith(deps)).post('/api/v1/demo/session')
      .set('Origin', ORIGIN)
      .set('Cookie', `${COOKIE}=${TOKEN}`)
      .set('X-CSRF-Token', 'demo-csrf')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ state: 'ready', principal: DEMO_PRINCIPAL, csrfToken: 'demo-csrf', expiresAt: expiresAt.toISOString() });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(deps.createSession.execute).not.toHaveBeenCalled();
  });

  it('preserves a valid regular cookie on conflict and rejects a missing CSRF token', async () => {
    const deps = dependencies({ kind: 'status', state: 'pending' }, { [REGULAR_TOKEN]: snapshot(REGULAR_PRINCIPAL, 'regular-csrf') });
    const app = appWith(deps);
    const conflict = await request(app).post('/api/v1/demo/session')
      .set('Origin', ORIGIN)
      .set('Cookie', `${COOKIE}=${REGULAR_TOKEN}`)
      .set('X-CSRF-Token', 'regular-csrf')
      .send({});
    const csrfFailure = await request(app).post('/api/v1/demo/session')
      .set('Origin', ORIGIN)
      .set('Cookie', `${COOKIE}=${REGULAR_TOKEN}`)
      .send({});

    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('DEMO_REGULAR_SESSION_ACTIVE');
    expect(conflict.headers['set-cookie']).toBeUndefined();
    expect(csrfFailure.status).toBe(403);
    expect(csrfFailure.body.error.code).toBe('CSRF_INVALID');
    expect(csrfFailure.headers['set-cookie']).toBeUndefined();
    expect(deps.createSession.execute).not.toHaveBeenCalled();
  });

  it('sets only the existing secure host cookie on initial admission', async () => {
    const rawToken = 'new-demo-session-token-with-at-least-32-characters';
    const deps = dependencies({ kind: 'created', session: { principal: DEMO_PRINCIPAL, rawToken, csrfToken: 'new-csrf', expiresAt } });
    const response = await anonymousPost(appWith(deps));

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({ state: 'ready', principal: DEMO_PRINCIPAL, csrfToken: 'new-csrf', expiresAt: expiresAt.toISOString() });
    const setCookie = response.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toContain(`${COOKIE}=${rawToken}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Domain=');
  });

  it('returns cookie-less status for a replay and clears only an invalid cookie', async () => {
    const deps = dependencies({ kind: 'status', state: 'pending' });
    const response = await request(appWith(deps)).post('/api/v1/demo/session')
      .set('Origin', ORIGIN)
      .set('Cookie', `${COOKIE}=expired-token-value-with-enough-length-123456`)
      .set('Idempotency-Key', Buffer.alloc(32, 2).toString('base64url'))
      .send({});

    expect(response.status).toBe(202);
    expect(response.body.data).toEqual({ state: 'pending' });
    const setCookie = response.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toContain(`${COOKIE}=`);
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).not.toContain('expired-token-value');
  });

  it('requires an empty JSON object, exact Origin, and an idempotency key for anonymous requests', async () => {
    const deps = dependencies();
    const app = appWith(deps);
    const extra = await request(app).post('/api/v1/demo/session').set('Origin', ORIGIN)
      .set('Idempotency-Key', Buffer.alloc(32, 3).toString('base64url')).send({ ownerId: DEMO_ID });
    const noKey = await request(app).post('/api/v1/demo/session').set('Origin', ORIGIN).send({});
    const wrongOrigin = await request(app).post('/api/v1/demo/session').set('Origin', 'https://other.example.test')
      .set('Idempotency-Key', Buffer.alloc(32, 4).toString('base64url')).send({});

    expect(extra.status).toBe(400);
    expect(noKey.status).toBe(400);
    expect(wrongOrigin.status).toBe(403);
    expect(deps.createSession.execute).not.toHaveBeenCalled();
  });

  it('ignores spoofed forwarded addresses unless the immediate peer matches a configured CIDR', async () => {
    const spoofedAddress = '198.51.100.42';
    const directDeps = dependencies();
    await anonymousPost(appWith(directDeps)).set('X-Forwarded-For', spoofedAddress).expect(202);
    expect(directDeps.clientIps).toHaveLength(1);
    expect(directDeps.clientIps[0]).not.toBe(spoofedAddress);

    const proxyDeps = dependencies();
    await anonymousPost(appWith(proxyDeps, ['127.0.0.1/32']))
      .set('X-Forwarded-For', spoofedAddress)
      .expect(202);
    expect(proxyDeps.clientIps).toEqual([spoofedAddress]);
  });
});
