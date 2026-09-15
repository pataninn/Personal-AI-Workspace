import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { GetReadinessUseCase } from '@/modules/health';
import { createLogger } from '@/shared/logging/logger';

describe('foundation health endpoints (integration)', () => {
  it('returns liveness and readiness envelopes', async () => {
    const readiness = new InMemoryReadinessState();
    readiness.markReady();
    const app = createApp({
      logger: createLogger('silent'),
      readiness: new GetReadinessUseCase(readiness),
      appVersion: 'test'
    });

    await request(app)
      .get('/health')
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual({ data: { status: 'ok' }, error: null });
      });
    await request(app)
      .get('/ready')
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual({ data: { status: 'ready', version: 'test' }, error: null });
      });
  });

  it('sends a static-app-compatible content security policy', async () => {
    const readiness = new InMemoryReadinessState();
    readiness.markReady();
    const app = createApp({
      logger: createLogger('silent'),
      readiness: new GetReadinessUseCase(readiness),
      appVersion: 'test'
    });

    await request(app)
      .get('/health')
      .expect(200)
      .expect(({ headers }: { headers: Record<string, string | undefined> }) => {
        const policy = headers['content-security-policy'];
        expect(policy).toBeDefined();
        expect(policy).toContain("default-src 'self'");
        expect(policy).toContain("script-src 'self'");
        expect(policy).toContain("style-src 'self'");
        expect(policy).toContain("connect-src 'self'");
        expect(policy).toContain("object-src 'none'");
        expect(policy).not.toContain("'unsafe-inline'");
      });
  });

  it('returns 503 and safe check failures before startup completes', async () => {
    const readiness = new InMemoryReadinessState();
    readiness.markFailed([{ check: 'database', code: 'DATABASE_UNAVAILABLE', message: 'PostgreSQL is unavailable or not ready.' }]);
    const app = createApp({
      logger: createLogger('silent'),
      readiness: new GetReadinessUseCase(readiness),
      appVersion: 'test'
    });

    await request(app)
      .get('/ready')
      .expect(503)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual({
          data: {
            status: 'not_ready',
            version: 'test',
            failures: [{ check: 'database', code: 'DATABASE_UNAVAILABLE', message: 'PostgreSQL is unavailable or not ready.' }]
          },
          error: null
        });
      });
  });

  it('does not return framework errors for unknown routes', async () => {
    const readiness = new InMemoryReadinessState();
    const app = createApp({
      logger: createLogger('silent'),
      readiness: new GetReadinessUseCase(readiness),
      appVersion: 'test'
    });

    await request(app)
      .get('/unknown')
      .expect(404)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual({
          data: null,
          error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' }
        });
      });
  });
});
