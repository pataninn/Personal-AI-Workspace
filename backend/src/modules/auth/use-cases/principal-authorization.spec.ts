import type { LocalUserRecord } from '@/modules/auth/domain/auth-types';
import type { IUserRepository } from '@/modules/auth/repositories/user-repository';
import type { IClock } from '@/modules/auth/repositories/security-providers';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import { PrincipalAuthorization } from '@/modules/auth/use-cases/principal-authorization';

const NOW = new Date('2026-10-19T00:00:00.000Z');

function user(overrides: Partial<LocalUserRecord> = {}): LocalUserRecord {
  return {
    id: 'principal-1',
    displayName: 'Account',
    accountKind: 'regular',
    role: 'user',
    identifier: 'account',
    passwordHash: 'hash',
    isActive: true,
    expiresAt: null,
    ...overrides
  };
}

function policy(record: LocalUserRecord | null): PrincipalAuthorization {
  const users = { findById: jest.fn().mockResolvedValue(record) } as unknown as IUserRepository;
  const clock: IClock = { now: () => NOW };
  return new PrincipalAuthorization(users, clock);
}

describe('PrincipalAuthorization', () => {
  it('allows an active regular account and an unexpired demo account', async () => {
    await expect(policy(user()).isActive('principal-1')).resolves.toBe(true);
    await expect(policy(user({ accountKind: 'demo', identifier: null, passwordHash: null, expiresAt: new Date(NOW.getTime() + 1) })).isActive('principal-1')).resolves.toBe(true);
  });

  it.each([
    ['missing', null],
    ['disabled', user({ isActive: false })],
    ['expired', user({ accountKind: 'demo', identifier: null, passwordHash: null, expiresAt: NOW })]
  ])('rejects a %s principal', async (_label, record) => {
    await expect(policy(record as LocalUserRecord | null).assertActive('principal-1')).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('does not turn repository errors into an active result', async () => {
    const users = { findById: jest.fn().mockRejectedValue(new Error('database unavailable')) } as unknown as IUserRepository;
    const access = new PrincipalAuthorization(users, { now: () => NOW });
    await expect(access.isActive('principal-1')).rejects.toThrow('database unavailable');
  });

  it('prefers the repository current-time predicate when available', async () => {
    const users = {
      isActive: jest.fn().mockResolvedValue(false),
      findById: jest.fn().mockResolvedValue(user())
    } as unknown as IUserRepository;
    const access = new PrincipalAuthorization(users, { now: () => NOW });

    await expect(access.isActive('principal-1')).resolves.toBe(false);
    expect(users.isActive).toHaveBeenCalledWith('principal-1');
    expect(users.findById).not.toHaveBeenCalled();
  });
});
