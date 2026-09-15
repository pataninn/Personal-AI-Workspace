import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import type { LocalUserRecord, SessionRecord } from '@/modules/auth/domain/auth-types';
import { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { LoginUseCase } from '@/modules/auth/use-cases/login';
import { LogoutUseCase } from '@/modules/auth/use-cases/logout';
import type { IClock, ILoginRateLimiter, IOpaqueTokenProvider, IPasswordHasher } from '@/modules/auth/repositories/security-providers';
import type { CreateSessionInput, ISessionRepository } from '@/modules/auth/repositories/session-repository';
import type { CreateLocalUserInput, IUserRepository } from '@/modules/auth/repositories/user-repository';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { GetReadinessUseCase } from '@/modules/health';
import { createLogger } from '@/shared/logging/logger';

const APP_ORIGIN = 'https://127.0.0.1:8443';
const NOW = new Date('2026-09-12T12:00:00.000Z');
const RAW_TOKEN = 'opaque-token-value-with-valid-length-123456';

class FakeUserRepository implements IUserRepository {
  public constructor(private readonly user: LocalUserRecord | null) {}

  public async findActiveLocalUser(): Promise<LocalUserRecord | null> {
    return this.user;
  }

  public async findActiveLocalUserById(): Promise<LocalUserRecord | null> {
    return this.user;
  }

  public async createLocalUser(_input: CreateLocalUserInput): Promise<LocalUserRecord> {
    throw new Error('Not needed by the auth integration fixture.');
  }
}

class FakeSessionRepository implements ISessionRepository {
  private readonly records = new Map<string, SessionRecord>();

  public async create(input: CreateSessionInput): Promise<Pick<SessionRecord, 'id' | 'userId' | 'expiresAt'>> {
    const record: SessionRecord = {
      id: 'session-1',
      userId: input.userId,
      displayName: 'Local user',
      expiresAt: input.expiresAt,
      revokedAt: null
    };
    this.records.set(input.tokenHash, record);
    return { id: record.id, userId: record.userId, expiresAt: record.expiresAt };
  }

  public async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.records.get(tokenHash) ?? null;
  }

  public async revoke(sessionId: string): Promise<void> {
    for (const [tokenHash, record] of this.records.entries()) {
      if (record.id === sessionId) {
        this.records.set(tokenHash, { ...record, revokedAt: NOW });
      }
    }
  }
}

class FixedTokenProvider implements IOpaqueTokenProvider {
  public createToken(): string {
    return RAW_TOKEN;
  }

  public digestToken(token: string): string {
    return `hash:${token}`;
  }

  public createCsrfToken(token: string): string {
    return `csrf:${token}`;
  }
}

class FixedClock implements IClock {
  public now(): Date {
    return NOW;
  }
}

class PasswordFixture implements IPasswordHasher {
  public async hash(password: string): Promise<string> {
    return `hash:${password}`;
  }

  public async verify(password: string, passwordHash: string): Promise<boolean> {
    return password === 'correct-password' && passwordHash === 'stored-hash';
  }
}

class AllowingRateLimiter implements ILoginRateLimiter {
  public consume(): boolean {
    return true;
  }
}

function buildApp(user: LocalUserRecord | null = {
  id: 'user-1',
  displayName: 'Local user',
  passwordHash: 'stored-hash',
  isActive: true
}): express.Express {
  const sessions = new FakeSessionRepository();
  const users = new FakeUserRepository(user);
  const tokenProvider = new FixedTokenProvider();
  const clock = new FixedClock();
  const passwordHasher = new PasswordFixture();
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  return createApp({
    logger: createLogger('silent'),
    readiness: new GetReadinessUseCase(readiness),
    appVersion: 'test',
    auth: {
      login: new LoginUseCase(users, sessions, passwordHasher, tokenProvider, clock, { sessionLifetimeMs: 60_000 }),
      getSession: new GetSessionUseCase(sessions, tokenProvider, clock),
      logout: new LogoutUseCase(sessions),
      appOrigin: APP_ORIGIN,
      cookieSecure: true,
      sessionLifetimeMs: 60_000,
      rateLimiter: new AllowingRateLimiter()
    }
  });
}

function cookiePair(response: request.Response): string {
  const headers = normalizeHeaderValues(response.headers['set-cookie']);
  const first = headers.find((value) => value.startsWith('__Host-pa_session='));
  if (!first) {
    throw new Error('The auth response did not set a session cookie.');
  }
  return first.split(';')[0] ?? first;
}

function normalizeHeaderValues(value: string | string[] | undefined): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  return value ?? [];
}

describe('local auth API (integration)', () => {
  it('requires the configured origin and validates the login body', async () => {
    const app = buildApp();

    await request(app).post('/api/v1/auth/login').send({ password: 'correct-password' }).expect(403);
    await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', APP_ORIGIN)
      .send({ password: '' })
      .expect(400)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ data: null, error: { code: 'VALIDATION_ERROR' } });
      });
    await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', APP_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ data: null, error: { code: 'VALIDATION_ERROR' } });
      });
  });

  it('sets a secure host-only cookie and returns no raw session token in JSON', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', APP_ORIGIN)
      .send({ password: 'correct-password' })
      .expect(200);

    expect(response.body).toEqual({
      data: {
        principal: { id: 'user-1', displayName: 'Local user' },
        csrfToken: `csrf:${RAW_TOKEN}`,
        expiresAt: '2026-09-12T12:01:00.000Z'
      },
      error: null
    });
    expect(JSON.stringify(response.body)).not.toContain('rawToken');
    const setCookie = normalizeHeaderValues(response.headers['set-cookie'])
      .find((value) => value.startsWith('__Host-pa_session='));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain(`__Host-pa_session=${RAW_TOKEN}`);
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Expires=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Domain=');
  });

  it('restores a session, rejects a bad CSRF token, and revokes on logout', async () => {
    const app = buildApp();
    const login = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', APP_ORIGIN)
      .send({ password: 'correct-password' })
      .expect(200);
    const cookie = cookiePair(login);

    await request(app)
      .get('/api/v1/auth/session')
      .set('Cookie', cookie)
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({
          data: { principal: { id: 'user-1' }, csrfToken: `csrf:${RAW_TOKEN}` },
          error: null
        });
      });
    await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'wrong')
      .expect(403)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ data: null, error: { code: 'CSRF_INVALID' } });
      });
    await request(app)
      .post('/api/v1/auth/logout')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', `csrf:${RAW_TOKEN}`)
      .expect(204)
      .expect(({ headers }: { headers: Record<string, string | string[] | undefined> }) => {
        const setCookie = normalizeHeaderValues(headers['set-cookie']);
        const clearedCookie = setCookie.find((value) => value.includes('__Host-pa_session=;'));
        expect(clearedCookie).toBeDefined();
        expect(clearedCookie).toContain('Max-Age=0');
        expect(clearedCookie).toContain('Path=/');
        expect(clearedCookie).toContain('HttpOnly');
        expect(clearedCookie).toContain('Secure');
        expect(clearedCookie).toContain('SameSite=Lax');
        expect(clearedCookie).not.toContain('Domain=');
      });
    await request(app).get('/api/v1/auth/session').set('Cookie', cookie).expect(401);
  });

  it('returns setup-required without suggesting a default credential', async () => {
    const app = buildApp(null);

    await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', APP_ORIGIN)
      .send({ password: 'anything' })
      .expect(503)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual({
          data: null,
          error: { code: 'SETUP_REQUIRED', message: 'Local setup is required before sign in is available.' }
        });
        expect(JSON.stringify(body)).not.toContain('anything');
      });
  });
});
