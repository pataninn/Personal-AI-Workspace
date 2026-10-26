import type { AuthSessionSnapshot, LocalUserRecord, SessionRecord } from '@/modules/auth/domain/auth-types';
import { InvalidCredentialsError, SetupRequiredError, UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import type { IClock, IOpaqueTokenProvider, IPasswordHasher } from '@/modules/auth/repositories/security-providers';
import type { ISessionRepository } from '@/modules/auth/repositories/session-repository';
import type { IUserRepository } from '@/modules/auth/repositories/user-repository';
import { BootstrapLocalUserUseCase } from '@/modules/auth/use-cases/bootstrap-local-user';
import { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { LoginUseCase } from '@/modules/auth/use-cases/login';
import { LogoutUseCase } from '@/modules/auth/use-cases/logout';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const RAW_TOKEN = 'opaque-token-value-with-valid-length-123456';

function userRecord(overrides: Partial<LocalUserRecord> = {}): LocalUserRecord {
  return {
    id: 'user-1',
    displayName: 'Local user',
    identifier: 'owner',
    accountKind: 'regular',
    role: 'admin',
    passwordHash: 'stored-hash',
    isActive: true,
    expiresAt: null,
    ...overrides
  };
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    userId: 'user-1',
    displayName: 'Local user',
    accountKind: 'regular',
    role: 'admin',
    accountExpiresAt: null,
    expiresAt: new Date('2026-09-13T12:00:00.000Z'),
    revokedAt: null,
    ...overrides
  };
}

function createUserRepository(overrides: Partial<jest.Mocked<IUserRepository>> = {}): jest.Mocked<IUserRepository> {
  return {
    findByIdentifier: jest.fn(),
    findById: jest.fn(),
    findBootstrapOwnerId: jest.fn(),
    hasAnyRegularAccounts: jest.fn().mockResolvedValue(true),
    createRegularAccount: jest.fn(),
    bootstrapInitialAdmin: jest.fn(),
    disableAccount: jest.fn(),
    ...overrides
  };
}

function createTokenProvider(): jest.Mocked<IOpaqueTokenProvider> {
  return {
    createToken: jest.fn().mockReturnValue(RAW_TOKEN),
    digestToken: jest.fn().mockReturnValue('opaque-token-hash'),
    createCsrfToken: jest.fn().mockReturnValue('csrf-value')
  };
}

function createClock(): jest.Mocked<IClock> {
  return { now: jest.fn().mockReturnValue(NOW) };
}

function createPasswordHasher(accepted = true): jest.Mocked<IPasswordHasher> {
  return {
    hash: jest.fn().mockResolvedValue('hashed-password'),
    verify: jest.fn().mockResolvedValue(accepted)
  };
}

function createSessionRepository(): jest.Mocked<ISessionRepository> {
  return {
    create: jest.fn().mockResolvedValue({ id: 'session-1', userId: 'user-1', expiresAt: new Date('2026-09-12T12:01:00.000Z') }),
    findByTokenHash: jest.fn(),
    revoke: jest.fn()
  };
}

describe('LoginUseCase', () => {
  it('returns setup required only when no accounts have been bootstrapped', async () => {
    const users = createUserRepository({
      findByIdentifier: jest.fn().mockResolvedValue(null),
      hasAnyRegularAccounts: jest.fn().mockResolvedValue(false)
    });
    const useCase = new LoginUseCase(users, createSessionRepository(), createPasswordHasher(), createTokenProvider(), createClock(), { sessionLifetimeMs: 60_000 });

    await expect(useCase.execute({ identifier: 'owner', password: 'password' })).rejects.toBeInstanceOf(SetupRequiredError);
  });

  it('normalizes identifiers and creates a session for the matching regular account', async () => {
    const users = createUserRepository({ findByIdentifier: jest.fn().mockResolvedValue(userRecord({ identifier: 'alice', displayName: 'Alice', role: 'user' })) });
    const sessions = createSessionRepository();
    const passwordHasher = createPasswordHasher();
    const tokenProvider = createTokenProvider();
    const useCase = new LoginUseCase(users, sessions, passwordHasher, tokenProvider, createClock(), { sessionLifetimeMs: 60_000 });

    const result = await useCase.execute({ identifier: '  ALIce ', password: 'correct-password' });

    expect(users.findByIdentifier).toHaveBeenCalledWith('alice');
    expect(passwordHasher.verify).toHaveBeenCalledWith('correct-password', 'stored-hash');
    expect(result.principal).toEqual({ id: 'user-1', displayName: 'Alice', accountKind: 'regular', role: 'user' });
    expect(sessions.create).toHaveBeenCalledWith({ userId: 'user-1', expectedPasswordHash: 'stored-hash', tokenHash: 'opaque-token-hash', expiresAt: new Date('2026-09-12T12:01:00.000Z') });
    expect(tokenProvider.digestToken).toHaveBeenCalledWith(RAW_TOKEN);
  });

  it.each([
    ['wrong password', userRecord(), false],
    ['disabled account', userRecord({ isActive: false }), true],
    ['passwordless demo account', userRecord({ identifier: null, accountKind: 'demo', role: 'user', passwordHash: null, expiresAt: new Date('2026-09-13T12:00:00.000Z') }), true]
  ])('rejects %s without creating a session', async (_label, user, passwordAccepted) => {
    const users = createUserRepository({ findByIdentifier: jest.fn().mockResolvedValue(user) });
    const sessions = createSessionRepository();
    const passwordHasher = createPasswordHasher(passwordAccepted);
    const useCase = new LoginUseCase(users, sessions, passwordHasher, createTokenProvider(), createClock(), { sessionLifetimeMs: 60_000 });

    await expect(useCase.execute({ identifier: 'owner', password: 'wrong-password' })).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(sessions.create).not.toHaveBeenCalled();
    if (!user.passwordHash || !user.isActive || user.accountKind !== 'regular') {
      expect(passwordHasher.verify).not.toHaveBeenCalled();
    }
  });

  it('uses the same credential error for an unknown identifier once accounts exist', async () => {
    const users = createUserRepository({ findByIdentifier: jest.fn().mockResolvedValue(null) });
    const useCase = new LoginUseCase(users, createSessionRepository(), createPasswordHasher(), createTokenProvider(), createClock(), { sessionLifetimeMs: 60_000 });

    await expect(useCase.execute({ identifier: 'not-the-owner', password: 'password' })).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});

describe('BootstrapLocalUserUseCase', () => {
  it('creates the owner admin once and never replaces the existing account password', async () => {
    const users = createUserRepository({
      findByIdentifier: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(userRecord({ isActive: false })),
      bootstrapInitialAdmin: jest.fn().mockResolvedValueOnce(true)
    });
    const passwordHasher = createPasswordHasher();
    const useCase = new BootstrapLocalUserUseCase(users, passwordHasher);

    await expect(useCase.execute({ password: 'operator-password', displayName: 'Pat' })).resolves.toBe(true);
    await expect(useCase.execute({ password: 'replacement-password', displayName: 'Other' })).resolves.toBe(false);

    expect(passwordHasher.hash).toHaveBeenCalledTimes(1);
    expect(passwordHasher.hash).toHaveBeenCalledWith('operator-password');
    expect(users.bootstrapInitialAdmin).toHaveBeenCalledWith({ displayName: 'Pat', passwordHash: 'hashed-password' });
  });
});

describe('GetSessionUseCase', () => {
  it.each([
    ['missing token', undefined, null],
    ['unknown token', RAW_TOKEN, null],
    ['revoked session', RAW_TOKEN, sessionRecord({ revokedAt: NOW })],
    ['expired session', RAW_TOKEN, sessionRecord({ expiresAt: NOW })],
    ['expired account', RAW_TOKEN, sessionRecord({ accountExpiresAt: NOW })]
  ])('rejects %s', async (_label, rawToken, record) => {
    const sessions: jest.Mocked<ISessionRepository> = {
      create: jest.fn(),
      findByTokenHash: jest.fn().mockResolvedValue(record),
      revoke: jest.fn()
    };
    const tokenProvider = createTokenProvider();
    const useCase = new GetSessionUseCase(sessions, tokenProvider, createClock());

    await expect(useCase.execute(rawToken)).rejects.toBeInstanceOf(UnauthenticatedError);
    if (rawToken) {
      expect(tokenProvider.digestToken).toHaveBeenCalledWith(rawToken);
    } else {
      expect(tokenProvider.digestToken).not.toHaveBeenCalled();
    }
  });

  it('returns the current account role and derives a CSRF value for a valid session', async () => {
    const sessions: jest.Mocked<ISessionRepository> = {
      create: jest.fn(),
      findByTokenHash: jest.fn().mockResolvedValue(sessionRecord()),
      revoke: jest.fn()
    };
    const tokenProvider = createTokenProvider();
    const useCase = new GetSessionUseCase(sessions, tokenProvider, createClock());

    const snapshot: AuthSessionSnapshot = await useCase.execute(RAW_TOKEN);

    expect(snapshot).toEqual({
      sessionId: 'session-1',
      principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular', role: 'admin' },
      csrfToken: 'csrf-value',
      expiresAt: new Date('2026-09-13T12:00:00.000Z')
    });
    expect(tokenProvider.createCsrfToken).toHaveBeenCalledWith(RAW_TOKEN);
  });
});

describe('LogoutUseCase', () => {
  it('revokes the authenticated session by id', async () => {
    const sessions: jest.Mocked<ISessionRepository> = {
      create: jest.fn(),
      findByTokenHash: jest.fn(),
      revoke: jest.fn().mockResolvedValue(undefined)
    };

    await expect(new LogoutUseCase(sessions).execute('session-1')).resolves.toBeUndefined();
    expect(sessions.revoke).toHaveBeenCalledWith('session-1');
  });
});
