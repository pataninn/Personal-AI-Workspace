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
    passwordHash: 'stored-hash',
    isActive: true,
    ...overrides
  };
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    userId: 'user-1',
    displayName: 'Local user',
    expiresAt: new Date('2026-09-13T12:00:00.000Z'),
    revokedAt: null,
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

describe('LoginUseCase', () => {
  it('returns setup required when no local user exists', async () => {
    const users: jest.Mocked<IUserRepository> = {
      findActiveLocalUser: jest.fn().mockResolvedValue(null),
      findActiveLocalUserById: jest.fn(),
      createLocalUser: jest.fn()
    };
    const useCase = new LoginUseCase(
      users,
      {} as jest.Mocked<ISessionRepository>,
      {} as jest.Mocked<IPasswordHasher>,
      createTokenProvider(),
      createClock(),
      { sessionLifetimeMs: 60_000 }
    );

    await expect(useCase.execute({ password: 'password' })).rejects.toBeInstanceOf(SetupRequiredError);
  });

  it('rejects a password without creating a session', async () => {
    const users: jest.Mocked<IUserRepository> = {
      findActiveLocalUser: jest.fn().mockResolvedValue(userRecord()),
      findActiveLocalUserById: jest.fn(),
      createLocalUser: jest.fn()
    };
    const passwordHasher: jest.Mocked<IPasswordHasher> = {
      hash: jest.fn(),
      verify: jest.fn().mockResolvedValue(false)
    };
    const sessions: jest.Mocked<ISessionRepository> = {
      create: jest.fn(),
      findByTokenHash: jest.fn(),
      revoke: jest.fn()
    };
    const useCase = new LoginUseCase(
      users,
      sessions,
      passwordHasher,
      createTokenProvider(),
      createClock(),
      { sessionLifetimeMs: 60_000 }
    );

    await expect(useCase.execute({ password: 'wrong-password' })).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('creates one opaque session and returns only a non-secret snapshot to the controller', async () => {
    const users: jest.Mocked<IUserRepository> = {
      findActiveLocalUser: jest.fn().mockResolvedValue(userRecord({ displayName: 'Pat' })),
      findActiveLocalUserById: jest.fn(),
      createLocalUser: jest.fn()
    };
    const sessions: jest.Mocked<ISessionRepository> = {
      create: jest.fn().mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        expiresAt: new Date('2026-09-12T12:01:00.000Z')
      }),
      findByTokenHash: jest.fn(),
      revoke: jest.fn()
    };
    const passwordHasher: jest.Mocked<IPasswordHasher> = {
      hash: jest.fn(),
      verify: jest.fn().mockResolvedValue(true)
    };
    const tokenProvider = createTokenProvider();
    const useCase = new LoginUseCase(
      users,
      sessions,
      passwordHasher,
      tokenProvider,
      createClock(),
      { sessionLifetimeMs: 60_000 }
    );

    const result = await useCase.execute({ password: 'correct-password' });

    expect(result).toEqual({
      sessionId: 'session-1',
      principal: { id: 'user-1', displayName: 'Pat' },
      rawToken: RAW_TOKEN,
      csrfToken: 'csrf-value',
      expiresAt: new Date('2026-09-12T12:01:00.000Z')
    });
    expect(sessions.create).toHaveBeenCalledWith({
      userId: 'user-1',
      tokenHash: 'opaque-token-hash',
      expiresAt: new Date('2026-09-12T12:01:00.000Z')
    });
    expect(tokenProvider.digestToken).toHaveBeenCalledWith(RAW_TOKEN);
  });
});

describe('BootstrapLocalUserUseCase', () => {
  it('hashes the operator password and bootstraps only when no user exists', async () => {
    const users: jest.Mocked<IUserRepository> = {
      findActiveLocalUser: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(userRecord()),
      findActiveLocalUserById: jest.fn(),
      createLocalUser: jest.fn().mockResolvedValue(userRecord())
    };
    const passwordHasher: jest.Mocked<IPasswordHasher> = {
      hash: jest.fn().mockResolvedValue('hashed-password'),
      verify: jest.fn()
    };
    const useCase = new BootstrapLocalUserUseCase(users, passwordHasher);

    await expect(useCase.execute({ password: 'operator-password', displayName: 'Pat' })).resolves.toBe(true);
    await expect(useCase.execute({ password: 'replacement-password', displayName: 'Other' })).resolves.toBe(false);

    expect(passwordHasher.hash).toHaveBeenCalledTimes(1);
    expect(passwordHasher.hash).toHaveBeenCalledWith('operator-password');
    expect(users.createLocalUser).toHaveBeenCalledWith({ displayName: 'Pat', passwordHash: 'hashed-password' });
  });
});

describe('GetSessionUseCase', () => {
  it.each([
    ['missing token', undefined, null],
    ['unknown token', RAW_TOKEN, null],
    ['revoked session', RAW_TOKEN, sessionRecord({ revokedAt: NOW })],
    ['expired session', RAW_TOKEN, sessionRecord({ expiresAt: NOW })]
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

  it('returns the current principal and derives a CSRF value for a valid session', async () => {
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
      principal: { id: 'user-1', displayName: 'Local user' },
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
