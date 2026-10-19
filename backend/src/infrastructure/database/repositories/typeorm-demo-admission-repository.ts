import type { DataSource, EntityManager } from 'typeorm';

import type { DemoAbuseLimitValues, BeginDemoAdmissionResult, CompleteDemoAdmissionInput, CompletedDemoAdmission, DemoAdmissionStatus, IDemoAdmissionRepository, IDemoRunStartAdmission } from '@/modules/demo/domain/demo-admission-types';
import { DemoAdmissionRateLimitedError, DemoAdmissionUnavailableError, DemoRunStartRateLimitedError } from '@/modules/demo/domain/demo-admission-errors';

interface AdmissionRow {
  readonly id: string;
  readonly owner_id: string | null;
  readonly status: DemoAdmissionStatus['state'];
  readonly expires_at: Date | string | null;
}

interface CreatedOwnerRow {
  readonly id: string;
  readonly display_name: string;
  readonly expires_at: Date | string;
}

interface CounterRow {
  readonly count: number;
  readonly max_count: number;
}

interface UserKindRow {
  readonly id: string;
  readonly account_kind: 'regular' | 'demo';
  readonly is_active: boolean;
  readonly expires_at: Date | string | null;
}

interface CompleteRow {
  readonly id: string;
  readonly display_name: string;
  readonly expires_at: Date | string;
}

function rows<T>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) throw new Error('The demo admission query returned an unexpected result.');
  if (value.length === 2 && Array.isArray(value[0]) && typeof value[1] === 'number') return value[0] as readonly T[];
  return value as readonly T[];
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError('A canonical UUID is required.');
  }
}

function assertHex(value: string, length: number): void {
  if (value.length !== length || !new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(value)) {
    throw new TypeError('A canonical hexadecimal identity is required.');
  }
}

export class TypeOrmDemoAdmissionRepository implements IDemoAdmissionRepository, IDemoRunStartAdmission {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly limits?: DemoAbuseLimitValues
  ) {}

  public async findStatusByRequestDigest(requestDigest: string): Promise<DemoAdmissionStatus | null> {
    assertHex(requestDigest, 64);
    const found = rows<Pick<AdmissionRow, 'status'>>(await this.dataSource.query(
      'SELECT "status" FROM "demo_admissions" WHERE "request_key_digest" = $1 LIMIT 1', [requestDigest]
    ))[0];
    return found ? { state: found.status } : null;
  }

  public async beginAdmission(input: {
    readonly requestDigest: string;
    readonly networkHash: string;
    readonly networkKeyId: string;
    readonly limits: DemoAbuseLimitValues;
    readonly lifetimeMs: number;
  }): Promise<BeginDemoAdmissionResult> {
    assertHex(input.requestDigest, 64);
    assertHex(input.networkHash, 64);
    assertHex(input.networkKeyId, 16);
    if (!Number.isSafeInteger(input.lifetimeMs) || input.lifetimeMs < 1 || input.lifetimeMs > 86_400_000) {
      throw new DemoAdmissionUnavailableError();
    }
    return this.dataSource.transaction(async (manager) => {
      // A single global lock makes key lookup and admission counters linearizable across all app instances.
      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('demo-admission-global', 0))");
      await manager.query('DELETE FROM "demo_admission_counters" WHERE "window_end" <= clock_timestamp()');
      const globalCounter = await this.lockAdmissionCounter(manager, {
        scopeKind: 'global_admission', scopeKey: 'global', networkKeyId: null,
        windowSeconds: input.limits.globalAdmissionWindowSeconds, maximum: input.limits.globalAdmissionMax
      });
      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('demo-admission-key:' || $1, 0))", [input.requestDigest]);

      const existing = rows<AdmissionRow>(await manager.query(
        'SELECT "id", "owner_id", "status", "expires_at" FROM "demo_admissions" WHERE "request_key_digest" = $1 FOR UPDATE',
        [input.requestDigest]
      ))[0];
      if (existing) return { kind: 'existing', status: { state: existing.status } } as const;

      const activeWindowMismatches = rows<{ readonly mismatched: boolean }>(await manager.query(`
        SELECT EXISTS (
          SELECT 1 FROM "demo_admission_counters"
          WHERE "window_end" > clock_timestamp() AND (
            ("scope_kind" = 'global_admission' AND "window_seconds" <> $1)
            OR ("scope_kind" = 'network_admission' AND "window_seconds" <> $2)
          )
        ) AS "mismatched"
      `, [input.limits.globalAdmissionWindowSeconds, input.limits.networkAdmissionWindowSeconds]))[0];
      if (activeWindowMismatches?.mismatched) throw new DemoAdmissionUnavailableError();

      const oldKeyWindow = rows<{ readonly exists: boolean }>(await manager.query(`
        SELECT EXISTS (
          SELECT 1 FROM "demo_admission_counters"
          WHERE "scope_kind" = 'network_admission' AND "window_end" > clock_timestamp()
            AND "network_key_id" <> $1
        ) AS "exists"
      `, [input.networkKeyId]))[0];
      if (oldKeyWindow?.exists) throw new DemoAdmissionUnavailableError();

      await manager.query(`
        INSERT INTO "demo_admissions" ("request_key_digest", "network_key_id", "network_hash", "status")
        VALUES ($1, $2, $3, 'pending')
      `, [input.requestDigest, input.networkKeyId, input.networkHash]);

      if (globalCounter.count >= globalCounter.max_count) throw new DemoAdmissionRateLimitedError();

      const networkCounter = await this.lockAdmissionCounter(manager, {
        scopeKind: 'network_admission', scopeKey: input.networkHash, networkKeyId: input.networkKeyId,
        windowSeconds: input.limits.networkAdmissionWindowSeconds, maximum: input.limits.networkAdmissionMax
      });
      if (networkCounter.count >= networkCounter.max_count) throw new DemoAdmissionRateLimitedError();

      const globalUpdated = rows<{ readonly count: number }>(await manager.query(`
        UPDATE "demo_admission_counters" SET "count" = "count" + 1, "updated_at" = clock_timestamp()
        WHERE "scope_kind" = 'global_admission' AND "scope_key" = 'global'
          AND "window_seconds" = $1 AND "window_start" = $2
        RETURNING "count"
      `, [input.limits.globalAdmissionWindowSeconds, globalCounter.window_start]));
      const networkUpdated = rows<{ readonly count: number }>(await manager.query(`
        UPDATE "demo_admission_counters" SET "count" = "count" + 1, "updated_at" = clock_timestamp()
        WHERE "scope_kind" = 'network_admission' AND "scope_key" = $1
          AND "window_seconds" = $2 AND "window_start" = $3
        RETURNING "count"
      `, [input.networkHash, input.limits.networkAdmissionWindowSeconds, networkCounter.window_start]));
      if (!globalUpdated[0] || !networkUpdated[0]) throw new DemoAdmissionUnavailableError();

      const users = rows<CreatedOwnerRow>(await manager.query(`
        INSERT INTO "users" ("scope_key", "identifier", "account_kind", "role", "display_name", "password_hash", "expires_at")
        VALUES ('account:' || replace(gen_random_uuid()::text, '-', ''), NULL, 'demo', 'user', 'Demo workspace', NULL,
          clock_timestamp() + ($1::bigint * interval '1 millisecond'))
        RETURNING "id", "display_name", "expires_at"
      `, [input.lifetimeMs]))[0];
      if (!users) throw new DemoAdmissionUnavailableError();
      await manager.query('INSERT INTO "account_limits" ("owner_id") VALUES ($1)', [users.id]);

      const admission = rows<AdmissionRow>(await manager.query(`
        UPDATE "demo_admissions"
        SET "owner_id" = $2,
          "expires_at" = (SELECT "expires_at" FROM "users" WHERE "id" = $2),
          "attempts" = 0, "updated_at" = clock_timestamp()
        WHERE "request_key_digest" = $1 AND "status" = 'pending'
        RETURNING "id", "owner_id", "status", "expires_at"
      `, [input.requestDigest, users.id]))[0];
      if (!admission) throw new DemoAdmissionUnavailableError();
      return {
        kind: 'created',
        admission: {
          admissionId: admission.id,
          ownerId: users.id,
          principal: { id: users.id, displayName: users.display_name, accountKind: 'demo', role: 'user' },
          expiresAt: asDate(users.expires_at)
        }
      } as const;
    });
  }

  public async recordProvisioningAttempt(admissionId: string): Promise<number> {
    assertUuid(admissionId);
    const attempt = rows<{ readonly attempts: number }>(await this.dataSource.query(`
      UPDATE "demo_admissions" SET "attempts" = "attempts" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = $1 AND "status" = 'pending' AND "attempts" < 3
      RETURNING "attempts"
    `, [admissionId]))[0];
    if (!attempt) throw new DemoAdmissionUnavailableError();
    return attempt.attempts;
  }

  public async markProvisioningFailed(
    admissionId: string,
    ownerId: string,
    failureCode: 'storage_unavailable' | 'storage_not_empty' | 'session_unavailable'
  ): Promise<void> {
    assertUuid(admissionId);
    assertUuid(ownerId);
    await this.dataSource.query(`
      UPDATE "demo_admissions" SET "status" = 'failed', "failure_code" = $3, "updated_at" = clock_timestamp()
      WHERE "id" = $1 AND "owner_id" = $2 AND "status" = 'pending'
    `, [admissionId, ownerId, failureCode]);
  }

  public async completeWithSession(input: CompleteDemoAdmissionInput): Promise<CompletedDemoAdmission> {
    assertUuid(input.admissionId);
    assertUuid(input.ownerId);
    assertHex(input.tokenHash, 64);
    return this.dataSource.transaction(async (manager) => {
      const admissions = rows<AdmissionRow>(await manager.query(`
        SELECT "id", "owner_id", "status", "expires_at" FROM "demo_admissions"
        WHERE "id" = $1 AND "owner_id" = $2 FOR UPDATE
      `, [input.admissionId, input.ownerId]));
      const admission = admissions[0];
      if (!admission || admission.status !== 'pending' || !admission.expires_at) throw new DemoAdmissionUnavailableError();

      const users = rows<CompleteRow>(await manager.query(`
        SELECT "id", "display_name", "expires_at" FROM "users"
        WHERE "id" = $1 AND "account_kind" = 'demo' AND "is_active" = true
          AND "expires_at" > clock_timestamp()
        FOR SHARE
      `, [input.ownerId]));
      const user = users[0];
      if (!user || asDate(user.expires_at).getTime() !== asDate(admission.expires_at).getTime()) {
        throw new DemoAdmissionUnavailableError();
      }

      const sessions = rows<{ readonly id: string; readonly expires_at: Date | string }>(await manager.query(`
        INSERT INTO "sessions" ("user_id", "token_hash", "expires_at")
        SELECT "id", $2, "expires_at" FROM "users" WHERE "id" = $1
        RETURNING "id", "expires_at"
      `, [input.ownerId, input.tokenHash]));
      const session = sessions[0];
      if (!session) throw new DemoAdmissionUnavailableError();
      const updated = rows<{ readonly id: string }>(await manager.query(`
        UPDATE "demo_admissions" SET "status" = 'ready', "updated_at" = clock_timestamp()
        WHERE "id" = $1 AND "owner_id" = $2 AND "status" = 'pending'
        RETURNING "id"
      `, [input.admissionId, input.ownerId]));
      if (!updated[0]) throw new DemoAdmissionUnavailableError();
      return {
        principal: { id: input.ownerId, displayName: user.display_name, accountKind: 'demo', role: 'user' },
        expiresAt: asDate(session.expires_at),
        sessionId: session.id
      };
    });
  }

  public async admitDemoRunStart(ownerId: string, runId: string): Promise<void> {
    assertUuid(ownerId);
    assertUuid(runId);
    await this.dataSource.transaction(async (manager) => {
      const users = rows<UserKindRow>(await manager.query(`
        SELECT "id", "account_kind", "is_active", "expires_at" FROM "users"
        WHERE "id" = $1 AND "is_active" = true AND ("expires_at" IS NULL OR "expires_at" > clock_timestamp())
        FOR SHARE
      `, [ownerId]));
      const user = users[0];
      if (!user) throw new DemoAdmissionUnavailableError();
      if (user.account_kind === 'regular') return;
      if (!this.limits) throw new DemoAdmissionUnavailableError();

      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('demo-run-start:' || $1, 0))", [ownerId]);
      await manager.query('DELETE FROM "demo_run_start_events" WHERE "window_end" <= clock_timestamp()');
      const mismatch = rows<{ readonly mismatched: boolean }>(await manager.query(`
        SELECT EXISTS (
          SELECT 1 FROM "demo_run_start_events" WHERE "owner_id" = $1
            AND "window_end" > clock_timestamp() AND "window_seconds" <> $2
        ) AS "mismatched"
      `, [ownerId, this.limits.runStartWindowSeconds]))[0];
      if (mismatch?.mismatched) throw new DemoAdmissionUnavailableError();

      const prior = rows<{ readonly run_id: string }>(await manager.query(
        'SELECT "run_id" FROM "demo_run_start_events" WHERE "owner_id" = $1 AND "run_id" = $2',
        [ownerId, runId]
      ));
      if (prior.length > 0) return;

      const window = rows<{ readonly window_start: Date | string; readonly window_end: Date | string }>(await manager.query(`
        WITH "clock" AS (SELECT clock_timestamp() AS "now")
        SELECT to_timestamp(floor(extract(epoch FROM "clock"."now") / $1) * $1) AS "window_start",
          to_timestamp(floor(extract(epoch FROM "clock"."now") / $1) * $1) + ($1 * interval '1 second') AS "window_end"
        FROM "clock"
      `, [this.limits.runStartWindowSeconds]))[0];
      if (!window) throw new DemoAdmissionUnavailableError();
      const counts = rows<{ readonly count: string }>(await manager.query(`
        SELECT count(*)::text AS "count" FROM "demo_run_start_events"
        WHERE "owner_id" = $1 AND "window_start" = $2
      `, [ownerId, window.window_start]));
      if (Number(counts[0]?.count ?? '0') >= this.limits.runStartMax) throw new DemoRunStartRateLimitedError();

      const inserted = rows<{ readonly run_id: string }>(await manager.query(`
        INSERT INTO "demo_run_start_events" ("owner_id", "run_id", "window_start", "window_end", "window_seconds")
        SELECT $1, $2, $3, $4, $5
        ON CONFLICT ("owner_id", "run_id") DO NOTHING
        RETURNING "run_id"
      `, [ownerId, runId, window.window_start, window.window_end, this.limits.runStartWindowSeconds]));
      if (!inserted[0]) return;
    });
  }

  private async lockAdmissionCounter(manager: EntityManager, input: {
    readonly scopeKind: 'global_admission' | 'network_admission';
    readonly scopeKey: string;
    readonly networkKeyId: string | null;
    readonly windowSeconds: number;
    readonly maximum: number;
  }): Promise<CounterRow & { readonly window_start: Date | string }> {
    const rowsFound = rows<CounterRow & { readonly window_start: Date | string }>(await manager.query(`
      INSERT INTO "demo_admission_counters" (
        "scope_kind", "scope_key", "network_key_id", "window_start", "window_end", "window_seconds", "max_count", "count"
      )
      SELECT $1, $2, $3, "window"."window_start", "window"."window_end", $4, $5, 0
      FROM (SELECT clock_timestamp() AS "now") AS "clock"
      CROSS JOIN LATERAL (
        SELECT to_timestamp(floor(extract(epoch FROM "clock"."now") / $4) * $4) AS "window_start",
          to_timestamp(floor(extract(epoch FROM "clock"."now") / $4) * $4) + ($4 * interval '1 second') AS "window_end"
      ) AS "window"
      ON CONFLICT ("scope_kind", "scope_key", "window_seconds", "window_start")
      DO UPDATE SET "max_count" = LEAST("demo_admission_counters"."max_count", EXCLUDED."max_count"),
        "updated_at" = clock_timestamp()
      RETURNING "count", "max_count", "window_start"
    `, [input.scopeKind, input.scopeKey, input.networkKeyId, input.windowSeconds, input.maximum]));
    const row = rowsFound[0];
    if (!row) throw new DemoAdmissionUnavailableError();
    return row;
  }
}
