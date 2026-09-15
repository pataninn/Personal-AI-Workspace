import type { DataSource } from 'typeorm';

import type { LocalUserRecord, SessionRecord } from '@/modules/auth/domain/auth-types';
import type { CreateSessionInput, ISessionRepository } from '@/modules/auth/repositories/session-repository';
import type { CreateLocalUserInput, IUserRepository } from '@/modules/auth/repositories/user-repository';

interface UserRow {
  readonly id: string;
  readonly display_name: string;
  readonly password_hash: string;
  readonly is_active: boolean;
}

interface SessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly display_name: string;
  readonly expires_at: Date | string;
  readonly revoked_at: Date | string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toLocalUser(row: UserRow): LocalUserRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    isActive: row.is_active
  };
}

export class TypeOrmUserRepository implements IUserRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async findActiveLocalUser(): Promise<LocalUserRecord | null> {
    const rows: readonly UserRow[] = await this.dataSource.query(
      'SELECT "id", "display_name", "password_hash", "is_active" FROM "users" WHERE "scope_key" = $1 AND "is_active" = true LIMIT 1',
      ['local']
    );
    return rows[0] ? toLocalUser(rows[0]) : null;
  }

  public async findActiveLocalUserById(userId: string): Promise<LocalUserRecord | null> {
    const rows: readonly UserRow[] = await this.dataSource.query(
      'SELECT "id", "display_name", "password_hash", "is_active" FROM "users" WHERE "id" = $1 AND "is_active" = true LIMIT 1',
      [userId]
    );
    return rows[0] ? toLocalUser(rows[0]) : null;
  }

  public async createLocalUser(input: CreateLocalUserInput): Promise<LocalUserRecord> {
    const rows: readonly UserRow[] = await this.dataSource.query(
      'INSERT INTO "users" ("scope_key", "display_name", "password_hash") VALUES ($1, $2, $3) RETURNING "id", "display_name", "password_hash", "is_active"',
      ['local', input.displayName, input.passwordHash]
    );
    const row = rows[0];
    if (!row) {
      throw new Error('The local user could not be created.');
    }
    return toLocalUser(row);
  }
}

export class TypeOrmSessionRepository implements ISessionRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async create(input: CreateSessionInput): Promise<Pick<SessionRecord, 'id' | 'userId' | 'expiresAt'>> {
    const rows: readonly { id: string; user_id: string; expires_at: Date | string }[] = await this.dataSource.query(
      'INSERT INTO "sessions" ("user_id", "token_hash", "expires_at") VALUES ($1, $2, $3) RETURNING "id", "user_id", "expires_at"',
      [input.userId, input.tokenHash, input.expiresAt]
    );
    const row = rows[0];
    if (!row) {
      throw new Error('The local session could not be created.');
    }
    return { id: row.id, userId: row.user_id, expiresAt: toDate(row.expires_at) };
  }

  public async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const rows: readonly SessionRow[] = await this.dataSource.query(
      'SELECT s."id", s."user_id", u."display_name", s."expires_at", s."revoked_at" FROM "sessions" s INNER JOIN "users" u ON u."id" = s."user_id" WHERE s."token_hash" = $1 AND u."is_active" = true LIMIT 1',
      [tokenHash]
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      expiresAt: toDate(row.expires_at),
      revokedAt: row.revoked_at === null ? null : toDate(row.revoked_at)
    };
  }

  public async revoke(sessionId: string): Promise<void> {
    await this.dataSource.query(
      'UPDATE "sessions" SET "revoked_at" = now(), "updated_at" = now() WHERE "id" = $1 AND "revoked_at" IS NULL',
      [sessionId]
    );
  }
}
