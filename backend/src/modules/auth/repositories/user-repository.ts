import type { AccountRole, LocalUserRecord } from '@/modules/auth/domain/auth-types';

export interface CreateRegularAccountInput {
  readonly identifier: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: AccountRole;
}

export type DisableAccountResult = 'disabled' | 'not-found' | 'forbidden' | 'last-active-admin';

export interface IUserRepository {
  findByIdentifier(identifier: string): Promise<LocalUserRecord | null>;
  findById(userId: string): Promise<LocalUserRecord | null>;
  /** Checks active/expiry state using the persistence clock when the adapter supports it. */
  isActive?(userId: string): Promise<boolean>;
  /** Returns the account bound to the immutable bootstrap scope, independent of its login identifier. */
  findBootstrapOwnerId(): Promise<string | null>;
  /** Holds a shared account-row lock for a short side-effect boundary when supported by the persistence adapter. */
  withActivePrincipal?<T>(userId: string, action: (assertStillActive: () => Promise<void>) => Promise<T>): Promise<T>;
  hasAnyRegularAccounts(): Promise<boolean>;
  createRegularAccount(input: CreateRegularAccountInput): Promise<LocalUserRecord>;
  bootstrapInitialAdmin(input: Omit<CreateRegularAccountInput, 'identifier' | 'role'>): Promise<boolean>;
  disableAccount(actorId: string, targetId: string): Promise<DisableAccountResult>;
}
