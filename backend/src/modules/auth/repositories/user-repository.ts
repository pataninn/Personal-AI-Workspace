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
  hasAnyRegularAccounts(): Promise<boolean>;
  createRegularAccount(input: CreateRegularAccountInput): Promise<LocalUserRecord>;
  bootstrapInitialAdmin(input: Omit<CreateRegularAccountInput, 'identifier' | 'role'>): Promise<boolean>;
  disableAccount(actorId: string, targetId: string): Promise<DisableAccountResult>;
}
