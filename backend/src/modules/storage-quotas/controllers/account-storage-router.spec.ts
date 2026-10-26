import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';

import type { SessionRecord } from '@/modules/auth/domain/auth-types';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import type { IClock, IOpaqueTokenProvider } from '@/modules/auth/repositories/security-providers';
import type { ISessionRepository } from '@/modules/auth/repositories/session-repository';
import { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { SESSION_COOKIE_NAME } from '@/modules/auth/controllers/request-auth';
import { createAccountStorageRouter } from '@/modules/storage-quotas/controllers/account-storage-router';
import type { StorageUsageSnapshot } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { IStorageQuotaRepository } from '@/modules/storage-quotas/repositories/storage-quota-repository';
import { GetStorageUsage } from '@/modules/storage-quotas/use-cases/get-storage-usage';
import { AppError } from '@/shared/errors/app-error';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const TOKEN_A = 'owner-a-session-token-with-more-than-32-chars';
const TOKEN_B = 'owner-b-session-token-with-more-than-32-chars';
const NOW = new Date('2026-10-19T00:00:00.000Z');

function snapshot(overrides: Partial<StorageUsageSnapshot> = {}): StorageUsageSnapshot {
  return {
    state: 'ready',
    usedBytes: 1234n,
    reservedBytes: 200n,
    limitBytes: null,
    availableBytes: null,
    overLimit: false,
    asOf: NOW,
    ...overrides
  };
}

function createSession(ownerId: string): SessionRecord {
  return {
    id: `session-${ownerId}`,
    userId: ownerId,
    displayName: ownerId === OWNER_A ? 'Owner A' : 'Owner B',
    accountKind: 'regular',
    role: 'user',
    accountExpiresAt: null,
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    revokedAt: null
  };
}

function buildApp(usages: ReadonlyMap<string, StorageUsageSnapshot> = new Map([
  [OWNER_A, snapshot({ usedBytes: 90071992547409931234n, reservedBytes: 25n, limitBytes: 90071992547410000000n, availableBytes: 68741n })],
  [OWNER_B, snapshot({ usedBytes: 777777n, reservedBytes: 0n, limitBytes: 777777n, availableBytes: 0n, overLimit: false })]
])): {
  readonly app: express.Express;
  readonly readUsage: jest.MockedFunction<IStorageQuotaRepository['readUsage']>;
  readonly clearSessionCookie: jest.Mock;
} {
  const sessions = new Map<string, SessionRecord>([
    [`digest:${TOKEN_A}`, createSession(OWNER_A)],
    [`digest:${TOKEN_B}`, createSession(OWNER_B)]
  ]);
  const sessionRepository: ISessionRepository = {
    create: async () => { throw new Error('Session creation is outside this route fixture.'); },
    findByTokenHash: async (tokenHash) => sessions.get(tokenHash) ?? null,
    revoke: async () => { throw new Error('Session revocation is outside this route fixture.'); }
  };
  const tokenProvider: IOpaqueTokenProvider = {
    createToken: () => 'unused',
    digestToken: (token) => `digest:${token}`,
    createCsrfToken: (token) => `csrf:${token}`
  };
  const clock: IClock = { now: () => NOW };
  const getSession = new GetSessionUseCase(sessionRepository, tokenProvider, clock);

  const readUsage: jest.MockedFunction<IStorageQuotaRepository['readUsage']> = jest.fn(async (ownerId) => {
    const value = usages.get(ownerId);
    if (!value) throw new Error('No storage fixture exists for this authenticated owner.');
    return value;
  });
  const storageRepository: IStorageQuotaRepository = {
    readUsage,
    runDatabaseMutation: async () => { throw new Error('Database mutations are outside this read-route fixture.'); },
    reserveFileOperation: async () => { throw new Error('File mutations are outside this read-route fixture.'); },
    listUnresolvedFileOperations: async () => [],
    settleFileOperation: async () => { throw new Error('File mutations are outside this read-route fixture.'); },
    releaseFileOperationWithNoSideEffect: async () => { throw new Error('File mutations are outside this read-route fixture.'); },
    markFileOperationUnknown: async () => { throw new Error('File mutations are outside this read-route fixture.'); },
    reconcileReferences: async () => { throw new Error('Reconciliation is outside this read-route fixture.'); },
    markAccountUnavailable: async () => { throw new Error('Reconciliation is outside this read-route fixture.'); }
  };
  const clearSessionCookie = jest.fn();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1', createAccountStorageRouter({
    getStorageUsage: new GetStorageUsage(storageRepository),
    getSession,
    clearSessionCookie
  }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof UnauthenticatedError) {
      response.status(401).json({ data: null, error: { code: 'SESSION_UNAUTHENTICATED', message: error.message } });
      return;
    }
    const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 500, 'Internal server error.');
    response.status(appError.statusCode).json({ data: null, error: { code: appError.code, message: appError.message } });
  });
  return { app, readUsage, clearSessionCookie };
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

describe('account storage route', () => {
  it('derives the owner from the authenticated session and preserves exact decimal byte strings', async () => {
    const { app, readUsage } = buildApp();

    const ownerA = await request(app)
      .get('/api/v1/account/storage?ownerId=22222222-2222-4222-8222-222222222222')
      .set('Cookie', sessionCookie(TOKEN_A));

    expect(ownerA.status).toBe(200);
    expect(ownerA.body).toEqual({
      data: {
        storage: {
          state: 'ready',
          unit: 'bytes',
          unitSystem: 'decimal-si',
          usedBytes: '90071992547409931234',
          reservedBytes: '25',
          limitBytes: '90071992547410000000',
          availableBytes: '68741',
          overLimit: false,
          asOf: NOW.toISOString()
        }
      },
      error: null
    });
    expect(readUsage).toHaveBeenCalledTimes(1);
    expect(readUsage).toHaveBeenCalledWith(OWNER_A);
    expect(JSON.stringify(ownerA.body)).not.toContain('777777');

    const ownerB = await request(app).get('/api/v1/account/storage').set('Cookie', sessionCookie(TOKEN_B));
    expect(ownerB.status).toBe(200);
    expect(ownerB.body.data.storage).toMatchObject({ usedBytes: '777777', limitBytes: '777777', overLimit: false });
    expect(JSON.stringify(ownerB.body)).not.toContain('90071992547409931234');
    expect(readUsage).toHaveBeenNthCalledWith(2, OWNER_B);
  });

  it('returns auth errors before reading usage and does not require a CSRF token or Origin for GET', async () => {
    const { app, readUsage, clearSessionCookie } = buildApp();

    const unauthenticated = await request(app).get('/api/v1/account/storage');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe('SESSION_UNAUTHENTICATED');
    expect(clearSessionCookie).not.toHaveBeenCalled();
    expect(readUsage).not.toHaveBeenCalled();

    const authenticatedRead = await request(app).get('/api/v1/account/storage').set('Cookie', sessionCookie(TOKEN_A));
    expect(authenticatedRead.status).toBe(200);
    expect(readUsage).toHaveBeenCalledWith(OWNER_A);
  });

  it.each([
    ['unlimited', snapshot({ usedBytes: 12n, reservedBytes: 3n, limitBytes: null, availableBytes: null, overLimit: false })],
    ['zero limit', snapshot({ usedBytes: 0n, reservedBytes: 0n, limitBytes: 0n, availableBytes: 0n, overLimit: false })],
    ['over limit', snapshot({ usedBytes: 15n, reservedBytes: 2n, limitBytes: 10n, availableBytes: 0n, overLimit: true })]
  ] as const)('returns %s values without converting null and zero into the same state', async (_label, value) => {
    const { app } = buildApp(new Map([[OWNER_A, value]]));
    const response = await request(app).get('/api/v1/account/storage').set('Cookie', sessionCookie(TOKEN_A));

    expect(response.status).toBe(200);
    expect(response.body.data.storage).toMatchObject({
      limitBytes: value.limitBytes?.toString() ?? null,
      availableBytes: value.availableBytes?.toString() ?? null,
      overLimit: value.overLimit
    });
  });

  it.each(['reconciling', 'unavailable'] as const)('keeps %s usage visibly unknown instead of reporting zero', async (state) => {
    const { app } = buildApp(new Map([[OWNER_A, snapshot({
      state,
      usedBytes: null,
      reservedBytes: null,
      limitBytes: 5000000000n,
      availableBytes: null,
      overLimit: null,
      asOf: null
    })]]));
    const response = await request(app).get('/api/v1/account/storage').set('Cookie', sessionCookie(TOKEN_A));

    expect(response.status).toBe(200);
    expect(response.body.data.storage).toMatchObject({
      state,
      usedBytes: null,
      reservedBytes: null,
      limitBytes: '5000000000',
      availableBytes: null,
      overLimit: null,
      asOf: null
    });
  });
});
