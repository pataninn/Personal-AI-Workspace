import type { DataSource, EntityManager } from 'typeorm';

import type { AccountKind, AccountRole, LocalUserRecord, SessionRecord } from '@/modules/auth/domain/auth-types';
import type { CreateSessionInput, ISessionRepository } from '@/modules/auth/repositories/session-repository';
import type { CreateRegularAccountInput, DisableAccountResult, IUserRepository } from '@/modules/auth/repositories/user-repository';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';

interface UserRow {
  readonly id: string;
  readonly display_name: string;
  readonly identifier: string | null;
  readonly account_kind: string;
  readonly role: string;
  readonly password_hash: string | null;
  readonly is_active: boolean;
  readonly expires_at: Date | string | null;
}

interface SessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly display_name: string;
  readonly account_kind: string;
  readonly role: string;
  readonly account_expires_at: Date | string | null;
  readonly expires_at: Date | string;
  readonly revoked_at: Date | string | null;
}

interface AccountStatusRow {
  readonly id: string;
  readonly role: string;
  readonly is_active: boolean;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function toAccountKind(value: string): AccountKind {
  if (value === 'regular' || value === 'demo') return value;
  throw new Error('The stored account kind is invalid.');
}

function toAccountRole(value: string): AccountRole {
  if (value === 'user' || value === 'admin') return value;
  throw new Error('The stored account role is invalid.');
}

function toLocalUser(row: UserRow): LocalUserRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    identifier: row.identifier,
    accountKind: toAccountKind(row.account_kind),
    role: toAccountRole(row.role),
    passwordHash: row.password_hash,
    isActive: row.is_active,
    expiresAt: toNullableDate(row.expires_at)
  };
}

const USER_SELECT = `
  SELECT "id", "display_name", "identifier", "account_kind", "role", "password_hash", "is_active", "expires_at"
  FROM "users"
`;

export class TypeOrmUserRepository implements IUserRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async findByIdentifier(identifier: string): Promise<LocalUserRecord | null> {
    const rows: readonly UserRow[] = await this.dataSource.query(
      `${USER_SELECT} WHERE "identifier" = $1 LIMIT 1`,
      [identifier]
    );
    return rows[0] ? toLocalUser(rows[0]) : null;
  }

  public async findById(userId: string): Promise<LocalUserRecord | null> {
    const rows: readonly UserRow[] = await this.dataSource.query(
      `${USER_SELECT} WHERE "id" = $1 LIMIT 1`,
      [userId]
    );
    return rows[0] ? toLocalUser(rows[0]) : null;
  }

  public async isActive(userId: string): Promise<boolean> {
    const rows: readonly { readonly active: boolean }[] = await this.dataSource.query(`
      SELECT EXISTS (
        SELECT 1 FROM "users"
        WHERE "id" = $1 AND "is_active" = true AND ("expires_at" IS NULL OR "expires_at" > now())
      ) AS "active"
    `, [userId]);
    return rows[0]?.active === true;
  }

  public async findBootstrapOwnerId(): Promise<string | null> {
    const rows: readonly { id: string }[] = await this.dataSource.query(
      'SELECT "id" FROM "users" WHERE "scope_key" = \'local\' LIMIT 1'
    );
    return rows[0]?.id ?? null;
  }

  public async withActivePrincipal<T>(userId: string, action: (assertStillActive: () => Promise<void>) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await assertActivePrincipal(manager, userId, true);
      return action(() => assertActivePrincipal(manager, userId, false));
    });
  }

  public async hasAnyRegularAccounts(): Promise<boolean> {
    const rows: readonly { exists: boolean }[] = await this.dataSource.query(
      'SELECT EXISTS (SELECT 1 FROM "users" WHERE "account_kind" = \'regular\') AS "exists"'
    );
    return rows[0]?.exists ?? false;
  }

  public async createRegularAccount(input: CreateRegularAccountInput): Promise<LocalUserRecord> {
    const rows: readonly UserRow[] = await this.dataSource.query(`
      INSERT INTO "users" ("scope_key", "identifier", "account_kind", "role", "display_name", "password_hash")
      VALUES ('account:' || replace(gen_random_uuid()::text, '-', ''), $1, 'regular', $2, $3, $4)
      RETURNING "id", "display_name", "identifier", "account_kind", "role", "password_hash", "is_active", "expires_at"
    `, [input.identifier, input.role, input.displayName, input.passwordHash]);
    const row = rows[0];
    if (!row) {
      throw new Error('The regular account could not be created.');
    }
    return toLocalUser(row);
  }

  public async bootstrapInitialAdmin(input: Omit<CreateRegularAccountInput, 'identifier' | 'role'>): Promise<boolean> {
    const rows: readonly { id: string }[] = await this.dataSource.query(`
      INSERT INTO "users" ("scope_key", "identifier", "account_kind", "role", "display_name", "password_hash")
      VALUES ('local', 'owner', 'regular', 'admin', $1, $2)
      ON CONFLICT DO NOTHING
      RETURNING "id"
    `, [input.displayName, input.passwordHash]);
    return rows.length > 0;
  }

  public async disableAccount(actorId: string, targetId: string): Promise<DisableAccountResult> {
    return this.dataSource.transaction(async (manager) => this.disableAccountInTransaction(manager, actorId, targetId));
  }

  private async disableAccountInTransaction(manager: EntityManager, actorId: string, targetId: string): Promise<DisableAccountResult> {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext('account-admin-status')::bigint)");

    const actors: readonly AccountStatusRow[] = await manager.query(
      'SELECT "id", "role", "is_active" FROM "users" WHERE "id" = $1 FOR UPDATE',
      [actorId]
    );
    const actor = actors[0];
    if (!actor || !actor.is_active || actor.role !== 'admin') {
      return 'forbidden';
    }

    const targets: readonly AccountStatusRow[] = await manager.query(
      'SELECT "id", "role", "is_active" FROM "users" WHERE "id" = $1 FOR UPDATE',
      [targetId]
    );
    const target = targets[0];
    if (!target) {
      return 'not-found';
    }
    if (target.is_active && target.role === 'admin') {
      const counts: readonly { count: string }[] = await manager.query(
        'SELECT count(*)::text AS "count" FROM "users" WHERE "role" = \'admin\' AND "is_active" = true'
      );
      if (Number(counts[0]?.count ?? 0) <= 1) {
        return 'last-active-admin';
      }
    }

    await manager.query('UPDATE "users" SET "is_active" = false, "updated_at" = now() WHERE "id" = $1 AND "is_active" = true', [targetId]);
    await manager.query(`
      UPDATE "sessions"
      SET "revoked_at" = COALESCE("revoked_at", now()), "updated_at" = now()
      WHERE "user_id" = $1 AND "revoked_at" IS NULL
    `, [targetId]);
    return 'disabled';
  }
}

async function assertActivePrincipal(manager: EntityManager, userId: string, lock: boolean): Promise<void> {
  const rows: readonly { id: string }[] = await manager.query(
    `SELECT "id" FROM "users" WHERE "id" = $1 AND "is_active" = true AND ("expires_at" IS NULL OR "expires_at" > now())${lock ? ' FOR SHARE' : ''}`,
    [userId]
  );
  if (!rows[0]) throw new UnauthenticatedError();
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
    const rows: readonly SessionRow[] = await this.dataSource.query(`
      SELECT s."id", s."user_id", u."display_name", u."account_kind", u."role", u."expires_at" AS "account_expires_at",
             s."expires_at", s."revoked_at"
      FROM "sessions" s
      INNER JOIN "users" u ON u."id" = s."user_id"
      WHERE s."token_hash" = $1 AND u."is_active" = true
      LIMIT 1
    `, [tokenHash]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      accountKind: toAccountKind(row.account_kind),
      role: toAccountRole(row.role),
      accountExpiresAt: toNullableDate(row.account_expires_at),
      expiresAt: toDate(row.expires_at),
      revokedAt: toNullableDate(row.revoked_at)
    };
  }

  public async revoke(sessionId: string): Promise<void> {
    await this.dataSource.query(
      'UPDATE "sessions" SET "revoked_at" = now(), "updated_at" = now() WHERE "id" = $1 AND "revoked_at" IS NULL',
      [sessionId]
    );
  }
}
