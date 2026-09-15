import type { LocalUserRecord } from '@/modules/auth/domain/auth-types';

export interface CreateLocalUserInput {
  readonly displayName: string;
  readonly passwordHash: string;
}

export interface IUserRepository {
  findActiveLocalUser(): Promise<LocalUserRecord | null>;
  findActiveLocalUserById(userId: string): Promise<LocalUserRecord | null>;
  createLocalUser(input: CreateLocalUserInput): Promise<LocalUserRecord>;
}
