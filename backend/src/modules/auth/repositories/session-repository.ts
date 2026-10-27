import type { SessionRecord } from '@/modules/auth/domain/auth-types';

export interface CreateSessionInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  /** Credential hash that was verified before a regular-account login. */
  readonly expectedPasswordHash?: string;
}

export interface ISessionRepository {
  create(input: CreateSessionInput): Promise<Pick<SessionRecord, 'id' | 'userId' | 'expiresAt'>>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  revoke(sessionId: string): Promise<void>;
}
