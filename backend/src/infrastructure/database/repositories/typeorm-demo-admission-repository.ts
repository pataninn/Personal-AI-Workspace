import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';

import type { DemoAbuseLimitValues, BeginDemoAdmissionResult, CompleteDemoAdmissionInput, CompletedDemoAdmission, DemoAdmissionStatus, IDemoAdmissionRepository, IDemoRunStartAdmission } from '@/modules/demo/domain/demo-admission-types';
import { DemoAdmissionRateLimitedError, DemoAdmissionUnavailableError, DemoRunStartRateLimitedError, DemoShowcaseUnavailableError } from '@/modules/demo/domain/demo-admission-errors';
import { DEFAULT_DEMO_STORAGE_LIMIT_BYTES, MAX_RETAINED_DEMO_ACCOUNTS } from '@/modules/demo/domain/demo-storage-policy';

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

function validAdmissionLimits(value: DemoAbuseLimitValues): boolean {
  return Number.isSafeInteger(value.globalAdmissionMax) && value.globalAdmissionMax >= 1 && value.globalAdmissionMax <= 1_000_000
    && Number.isSafeInteger(value.globalAdmissionWindowSeconds) && value.globalAdmissionWindowSeconds >= 60 && value.globalAdmissionWindowSeconds <= 604_800
    && Number.isSafeInteger(value.networkAdmissionMax) && value.networkAdmissionMax >= 1 && value.networkAdmissionMax <= 1_000_000
    && Number.isSafeInteger(value.networkAdmissionWindowSeconds) && value.networkAdmissionWindowSeconds >= 60 && value.networkAdmissionWindowSeconds <= 604_800
    && Number.isSafeInteger(value.runStartMax) && value.runStartMax >= 1 && value.runStartMax <= 1_000_000
    && Number.isSafeInteger(value.runStartWindowSeconds) && value.runStartWindowSeconds >= 60 && value.runStartWindowSeconds <= 604_800
    && value.networkAdmissionWindowSeconds <= value.globalAdmissionWindowSeconds;
}

export class TypeOrmDemoAdmissionRepository implements IDemoAdmissionRepository, IDemoRunStartAdmission {
  public constructor(private readonly dataSource: DataSource) {}

  /** Copies deployment defaults once; later processes treat the database as the sole policy authority. */
  public async bootstrapSettings(input: { readonly lifetimeHours: number; readonly limits?: DemoAbuseLimitValues }): Promise<void> {
    const ttlHours = Number.isSafeInteger(input.lifetimeHours) && input.lifetimeHours >= 1 && input.lifetimeHours <= 24
      ? input.lifetimeHours : null;
    const configuredLimits = input.limits && validAdmissionLimits(input.limits) ? input.limits : undefined;
    await this.dataSource.transaction(async (manager) => {
      const policy = rows<{ readonly demo_settings_bootstrapped: boolean }>(await manager.query(
        'SELECT "demo_settings_bootstrapped" FROM "credit_runtime_policy" WHERE "id" = 1 FOR UPDATE'
      ))[0];
      if (!policy) throw new DemoAdmissionUnavailableError();
      if (policy.demo_settings_bootstrapped) return;
      await manager.query(`
        UPDATE "credit_runtime_policy" SET
          "demo_session_ttl_hours" = $1,
          "demo_global_admission_max" = $2, "demo_global_admission_window_seconds" = $3,
          "demo_network_admission_max" = $4, "demo_network_admission_window_seconds" = $5,
          "demo_run_start_max" = $6, "demo_run_start_window_seconds" = $7,
          "demo_settings_bootstrapped" = true, "updated_at" = clock_timestamp()
        WHERE "id" = 1 AND "demo_settings_bootstrapped" = false
      `, [ttlHours, configuredLimits?.globalAdmissionMax ?? null, configuredLimits?.globalAdmissionWindowSeconds ?? null,
        configuredLimits?.networkAdmissionMax ?? null, configuredLimits?.networkAdmissionWindowSeconds ?? null,
        configuredLimits?.runStartMax ?? null, configuredLimits?.runStartWindowSeconds ?? null]);
    });
  }

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
  }): Promise<BeginDemoAdmissionResult> {
    assertHex(input.requestDigest, 64);
    assertHex(input.networkHash, 64);
    assertHex(input.networkKeyId, 16);
    return this.dataSource.transaction(async (manager) => {
      // A single global lock makes key lookup and admission counters linearizable across all app instances.
      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('demo-admission-global', 0))");
      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('demo-admission-key:' || $1, 0))", [input.requestDigest]);

      const existing = rows<AdmissionRow>(await manager.query(
        'SELECT "id", "owner_id", "status", "expires_at" FROM "demo_admissions" WHERE "request_key_digest" = $1 FOR UPDATE',
        [input.requestDigest]
      ))[0];
      if (existing) return { kind: 'existing', status: { state: existing.status } } as const;

      // The global admission lock also reserves fleet capacity. Expiry alone cannot free retained bytes.
      const retained = rows<{ readonly retained_demo_owners: number }>(await manager.query(
        `SELECT count(*)::integer AS "retained_demo_owners" FROM "users" WHERE "account_kind" = 'demo'`
      ))[0];
      if (!retained || !Number.isSafeInteger(retained.retained_demo_owners) || retained.retained_demo_owners < 0) {
        throw new DemoAdmissionUnavailableError();
      }
      if (retained.retained_demo_owners >= MAX_RETAINED_DEMO_ACCOUNTS) throw new DemoAdmissionRateLimitedError();

      const policy = rows<{
        readonly demo_settings_bootstrapped: boolean; readonly demo_session_ttl_hours: number | null;
        readonly demo_global_admission_max: number | null; readonly demo_global_admission_window_seconds: number | null;
        readonly demo_network_admission_max: number | null; readonly demo_network_admission_window_seconds: number | null;
        readonly demo_run_start_max: number | null; readonly demo_run_start_window_seconds: number | null;
        readonly demo_default_daily_limit_units: string | null; readonly demo_default_lifetime_limit_units: string | null;
      }>(await manager.query('SELECT * FROM "credit_runtime_policy" WHERE "id" = 1 FOR SHARE'))[0];
      if (!policy || !policy.demo_settings_bootstrapped || !policy.demo_session_ttl_hours
        || !policy.demo_global_admission_max || !policy.demo_global_admission_window_seconds
        || !policy.demo_network_admission_max || !policy.demo_network_admission_window_seconds
        || !policy.demo_run_start_max || !policy.demo_run_start_window_seconds
        || policy.demo_network_admission_window_seconds > policy.demo_global_admission_window_seconds) {
        throw new DemoAdmissionUnavailableError();
      }
      const limits: DemoAbuseLimitValues = {
        globalAdmissionMax: policy.demo_global_admission_max,
        globalAdmissionWindowSeconds: policy.demo_global_admission_window_seconds,
        networkAdmissionMax: policy.demo_network_admission_max,
        networkAdmissionWindowSeconds: policy.demo_network_admission_window_seconds,
        runStartMax: policy.demo_run_start_max,
        runStartWindowSeconds: policy.demo_run_start_window_seconds
      };
      const lifetimeMs = policy.demo_session_ttl_hours * 60 * 60 * 1000;

      // A shared pointer lock makes this immutable version pin atomic with publication pruning.
      const current = rows<{ readonly version_id: string }>(await manager.query(`
        SELECT p."current_version_id" AS "version_id"
        FROM "showcase_publication" p
        JOIN "showcase_versions" v ON v."id" = p."current_version_id"
        WHERE p."singleton_id" = true
        FOR SHARE OF p
      `))[0];
      if (!current?.version_id) throw new DemoShowcaseUnavailableError();

      await manager.query('DELETE FROM "demo_admission_counters" WHERE "window_end" <= clock_timestamp()');
      const globalCounter = await this.lockAdmissionCounter(manager, {
        scopeKind: 'global_admission', scopeKey: 'global', networkKeyId: null,
        windowSeconds: limits.globalAdmissionWindowSeconds, maximum: limits.globalAdmissionMax
      });

      const activeWindowMismatches = rows<{ readonly mismatched: boolean }>(await manager.query(`
        SELECT EXISTS (
          SELECT 1 FROM "demo_admission_counters"
          WHERE "window_end" > clock_timestamp() AND (
            ("scope_kind" = 'global_admission' AND "window_seconds" <> $1)
            OR ("scope_kind" = 'network_admission' AND "window_seconds" <> $2)
          )
        ) AS "mismatched"
      `, [limits.globalAdmissionWindowSeconds, limits.networkAdmissionWindowSeconds]))[0];
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
        windowSeconds: limits.networkAdmissionWindowSeconds, maximum: limits.networkAdmissionMax
      });
      if (networkCounter.count >= networkCounter.max_count) throw new DemoAdmissionRateLimitedError();

      const globalUpdated = rows<{ readonly count: number }>(await manager.query(`
        UPDATE "demo_admission_counters" SET "count" = "count" + 1, "updated_at" = clock_timestamp()
        WHERE "scope_kind" = 'global_admission' AND "scope_key" = 'global'
          AND "window_seconds" = $1 AND "window_start" = $2
        RETURNING "count"
      `, [limits.globalAdmissionWindowSeconds, globalCounter.window_start]));
      const networkUpdated = rows<{ readonly count: number }>(await manager.query(`
        UPDATE "demo_admission_counters" SET "count" = "count" + 1, "updated_at" = clock_timestamp()
        WHERE "scope_kind" = 'network_admission' AND "scope_key" = $1
          AND "window_seconds" = $2 AND "window_start" = $3
        RETURNING "count"
      `, [input.networkHash, limits.networkAdmissionWindowSeconds, networkCounter.window_start]));
      if (!globalUpdated[0] || !networkUpdated[0]) throw new DemoAdmissionUnavailableError();

      const users = rows<CreatedOwnerRow>(await manager.query(`
        INSERT INTO "users" ("scope_key", "identifier", "account_kind", "role", "display_name", "password_hash", "expires_at")
        VALUES ('account:' || replace(gen_random_uuid()::text, '-', ''), NULL, 'demo', 'user', 'Demo workspace', NULL,
          clock_timestamp() + ($1::bigint * interval '1 millisecond'))
        RETURNING "id", "display_name", "expires_at"
      `, [lifetimeMs]))[0];
      if (!users) throw new DemoAdmissionUnavailableError();
      const demoLimitsConfigured = policy.demo_default_daily_limit_units !== null || policy.demo_default_lifetime_limit_units !== null;
      await manager.query(`INSERT INTO "account_limits" (
        "owner_id", "daily_credit_limit_units", "lifetime_credit_limit_units", "demo_credit_limits_configured", "storage_limit_bytes"
      ) VALUES ($1, $2, $3, $4, $5)`, [users.id, policy.demo_default_daily_limit_units, policy.demo_default_lifetime_limit_units, demoLimitsConfigured, DEFAULT_DEMO_STORAGE_LIMIT_BYTES.toString()]);

      const admission = rows<AdmissionRow>(await manager.query(`
        UPDATE "demo_admissions"
        SET "owner_id" = $2,
          "expires_at" = (SELECT "expires_at" FROM "users" WHERE "id" = $2),
          "attempts" = 0, "updated_at" = clock_timestamp()
        WHERE "request_key_digest" = $1 AND "status" = 'pending'
        RETURNING "id", "owner_id", "status", "expires_at"
      `, [input.requestDigest, users.id]))[0];
      if (!admission) throw new DemoAdmissionUnavailableError();
      const additional = rows<{ readonly version_id: string }>(await manager.query(
        'SELECT "version_id" FROM "showcase_publication_workspaces" ORDER BY "position"'
      ));
      const versions = [...new Set([current.version_id, ...additional.map((row) => row.version_id)])];
      if (versions.length > 3) throw new DemoShowcaseUnavailableError();
      for (const [index, versionId] of versions.entries()) {
        await manager.query(`
          INSERT INTO "demo_showcase_copies" ("copy_id", "admission_id", "owner_id", "pinned_version_id", "target_project_id")
          VALUES ($1, $2, $3, $4, $5)
        `, [index === 0 ? admission.id : randomUUID(), admission.id, users.id, versionId, randomUUID()]);
      }
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
      const hint = rows<{ readonly account_kind: 'regular' | 'demo' }>(await manager.query(
        'SELECT "account_kind" FROM "users" WHERE "id" = $1', [ownerId]
      ))[0];
      if (!hint) throw new DemoAdmissionUnavailableError();
      if (hint.account_kind === 'regular') return;
      const policy = rows<{ readonly demo_settings_bootstrapped: boolean; readonly demo_run_start_max: number | null;
        readonly demo_run_start_window_seconds: number | null }>(await manager.query(
        'SELECT "demo_settings_bootstrapped", "demo_run_start_max", "demo_run_start_window_seconds" FROM "credit_runtime_policy" WHERE "id" = 1 FOR SHARE'
      ))[0];
      if (!policy?.demo_settings_bootstrapped || !policy.demo_run_start_max || !policy.demo_run_start_window_seconds) {
        throw new DemoAdmissionUnavailableError();
      }
      const users = rows<UserKindRow>(await manager.query(`
        SELECT "id", "account_kind", "is_active", "expires_at" FROM "users"
        WHERE "id" = $1 AND "is_active" = true AND ("expires_at" IS NULL OR "expires_at" > clock_timestamp())
        FOR SHARE
      `, [ownerId]));
      const user = users[0];
      if (!user) throw new DemoAdmissionUnavailableError();
      if (user.account_kind === 'regular') return;

      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('demo-run-start:' || $1, 0))", [ownerId]);
      await manager.query('DELETE FROM "demo_run_start_events" WHERE "window_end" <= clock_timestamp()');
      const mismatch = rows<{ readonly mismatched: boolean }>(await manager.query(`
        SELECT EXISTS (
          SELECT 1 FROM "demo_run_start_events" WHERE "owner_id" = $1
            AND "window_end" > clock_timestamp() AND "window_seconds" <> $2
        ) AS "mismatched"
      `, [ownerId, policy.demo_run_start_window_seconds]))[0];
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
      `, [policy.demo_run_start_window_seconds]))[0];
      if (!window) throw new DemoAdmissionUnavailableError();
      const counts = rows<{ readonly count: string }>(await manager.query(`
        SELECT count(*)::text AS "count" FROM "demo_run_start_events"
        WHERE "owner_id" = $1 AND "window_start" = $2
      `, [ownerId, window.window_start]));
      if (Number(counts[0]?.count ?? '0') >= policy.demo_run_start_max) throw new DemoRunStartRateLimitedError();

      const inserted = rows<{ readonly run_id: string }>(await manager.query(`
        INSERT INTO "demo_run_start_events" ("owner_id", "run_id", "window_start", "window_end", "window_seconds")
        SELECT $1, $2, $3, $4, $5
        ON CONFLICT ("owner_id", "run_id") DO NOTHING
        RETURNING "run_id"
      `, [ownerId, runId, window.window_start, window.window_end, policy.demo_run_start_window_seconds]));
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
