import type { DataSource, EntityManager } from 'typeorm';

import { creditDailyWindowAt, utcDailyWindowAt } from '@/modules/credits/domain/credit-time-windows';
import { AppError } from '@/shared/errors/app-error';
import type { AccountLimitsInput, DemoSettingsInput, IAdminPortalRepository } from '@/modules/admin-portal/repositories/admin-portal-repository';

type Queryable = Pick<EntityManager, 'query'>;
type AdminUserRow = {
  id: string; display_name: string; identifier: string | null; account_kind: 'regular' | 'demo'; role: 'user' | 'admin';
  is_active: boolean; expires_at: Date | string | null; limits_revision: string; demo_credit_limits_configured: boolean;
  daily_credit_limit_units: string | null; lifetime_credit_limit_units: string | null; storage_limit_bytes: string | null;
  daily_settled: string | null; daily_reserved: string | null; lifetime_settled: string | null; lifetime_reserved: string | null;
  storage_used: string | null; storage_reserved: string | null; storage_state: 'ready' | 'reconciling' | 'unavailable' | null;
  storage_updated_at: Date | string | null; active_admin_count: string;
};
type PolicyRow = {
  revision: string; inference_paused: boolean; demo_daily_limit_units: string | null; demo_campaign_limit_units: string | null;
  demo_campaign_id: string | null; demo_max_concurrent_calls: number; demo_default_daily_limit_units: string | null;
  demo_default_lifetime_limit_units: string | null; demo_session_ttl_hours: number | null;
  demo_global_admission_max: number | null; demo_global_admission_window_seconds: number | null;
  demo_network_admission_max: number | null; demo_network_admission_window_seconds: number | null;
  demo_run_start_max: number | null; demo_run_start_window_seconds: number | null; demo_settings_bootstrapped: boolean;
};
type UsageRow = {
  id: string; account_kind: 'regular' | 'demo'; is_active: boolean; expires_at: Date | string | null;
  daily_credit_limit_units: string | null; lifetime_credit_limit_units: string | null; demo_credit_limits_configured: boolean;
  credit_timezone: string; pending_credit_timezone: string | null; timezone_effective_at: Date | string | null;
  timezone_started_at: Date | string | null; lifetime_settled: string | null; lifetime_reserved: string | null;
  inference_paused: boolean; demo_daily_limit_units: string | null; demo_campaign_limit_units: string | null;
  demo_campaign_id: string | null;
};

function rows<T>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) throw new Error('The admin database query returned an unexpected result.');
  if (value.length === 2 && Array.isArray(value[0]) && typeof value[1] === 'number') return value[0] as readonly T[];
  return value as readonly T[];
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function remaining(limit: string | null, settled: string, reserved: string): string | null {
  if (limit === null) return null;
  const result = BigInt(limit) - BigInt(settled) - BigInt(reserved);
  return (result > 0n ? result : 0n).toString();
}

function creditSummary(limit: string | null, settled: string, reserved: string): Record<string, string | null> {
  return { limitUnits: limit, settledUnits: settled, reservedUnits: reserved, remainingUnits: remaining(limit, settled, reserved) };
}

function storageSummary(row: AdminUserRow): Record<string, string | boolean | null> {
  const used = row.storage_state === 'ready' ? row.storage_used : null;
  const reserved = row.storage_state === 'ready' ? row.storage_reserved : null;
  return {
    state: row.storage_state ?? 'reconciling', usedBytes: used, reservedBytes: reserved, limitBytes: row.storage_limit_bytes,
    overLimit: used !== null && reserved !== null && row.storage_limit_bytes !== null
      ? BigInt(used) + BigInt(reserved) > BigInt(row.storage_limit_bytes) : null,
    asOf: used === null ? null : asDate(row.storage_updated_at)?.toISOString() ?? null
  };
}

function toPolicyDto(policy: PolicyRow, daily: { settled: string; reserved: string }, campaign: { settled: string; reserved: string }): Record<string, unknown> {
  return {
    revision: Number(policy.revision), demoSettingsBootstrapped: policy.demo_settings_bootstrapped,
    defaultDailyLimitUnits: policy.demo_default_daily_limit_units,
    defaultLifetimeLimitUnits: policy.demo_default_lifetime_limit_units,
    sessionTtlHours: policy.demo_session_ttl_hours,
    globalAdmissionMax: policy.demo_global_admission_max,
    globalAdmissionWindowSeconds: policy.demo_global_admission_window_seconds,
    networkAdmissionMax: policy.demo_network_admission_max,
    networkAdmissionWindowSeconds: policy.demo_network_admission_window_seconds,
    runStartMax: policy.demo_run_start_max,
    runStartWindowSeconds: policy.demo_run_start_window_seconds,
    maxConcurrentCalls: policy.demo_max_concurrent_calls,
    globalDailyLimitUnits: policy.demo_daily_limit_units,
    campaignId: policy.demo_campaign_id,
    campaignLimitUnits: policy.demo_campaign_limit_units,
    inferencePaused: policy.inference_paused,
    usage: { dailySettledUnits: daily.settled, dailyReservedUnits: daily.reserved,
      campaignSettledUnits: campaign.settled, campaignReservedUnits: campaign.reserved, dailyTimeZone: 'UTC' }
  };
}

export class TypeOrmAdminPortalRepository implements IAdminPortalRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async listAccounts(search: string): Promise<unknown> {
    const found = rows<AdminUserRow>(await this.dataSource.query(`
      SELECT u."id", u."display_name", u."identifier", u."account_kind", u."role", u."is_active", u."expires_at",
        l."limits_revision", l."demo_credit_limits_configured", l."daily_credit_limit_units"::text,
        l."lifetime_credit_limit_units"::text, l."storage_limit_bytes"::text,
        COALESCE(d."settled_units", 0)::text AS "daily_settled", COALESCE(d."reserved_units", 0)::text AS "daily_reserved",
        COALESCE(t."settled_units", 0)::text AS "lifetime_settled", COALESCE(t."reserved_units", 0)::text AS "lifetime_reserved",
        st."used_bytes"::text AS "storage_used", st."reserved_bytes"::text AS "storage_reserved",
        st."accounting_state" AS "storage_state", st."updated_at" AS "storage_updated_at",
        (SELECT count(*)::text FROM "users" a WHERE a."role" = 'admin' AND a."is_active" = true) AS "active_admin_count"
      FROM "users" u
      JOIN "account_limits" l ON l."owner_id" = u."id"
      LEFT JOIN "credit_account_totals" t ON t."owner_id" = u."id"
      LEFT JOIN LATERAL (SELECT w."settled_units", w."reserved_units" FROM "credit_account_daily_windows" w
        WHERE w."owner_id" = u."id" AND now() >= w."window_start" AND now() < w."window_end"
        ORDER BY w."window_start" DESC LIMIT 1) d ON true
      LEFT JOIN "storage_account_totals" st ON st."owner_id" = u."id"
      WHERE $1 = '' OR COALESCE(u."identifier", '') ILIKE ('%' || $1 || '%') OR u."display_name" ILIKE ('%' || $1 || '%')
      ORDER BY u."created_at" DESC, u."id" LIMIT 100
    `, [search]));
    return { accounts: found.map((row) => ({
      id: row.id, displayName: row.display_name, identifier: row.identifier, accountKind: row.account_kind,
      role: row.role, enabled: row.is_active, expiresAt: asDate(row.expires_at)?.toISOString() ?? null,
      limitsRevision: Number(row.limits_revision), demoCreditLimitsConfigured: row.demo_credit_limits_configured,
      daily: creditSummary(row.daily_credit_limit_units, row.daily_settled ?? '0', row.daily_reserved ?? '0'),
      lifetime: creditSummary(row.lifetime_credit_limit_units, row.lifetime_settled ?? '0', row.lifetime_reserved ?? '0'),
      storage: storageSummary(row),
      canDisable: !(row.is_active && row.role === 'admin' && Number(row.active_admin_count) <= 1),
      disableReason: row.is_active && row.role === 'admin' && Number(row.active_admin_count) <= 1 ? 'Keep at least one active administrator.' : null
    })) };
  }

  public async readCreditUsage(ownerId: string): Promise<unknown> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const nowRows = rows<{ now: Date | string }>(await manager.query('SELECT now() AS "now"'));
      const now = asDate(nowRows[0]?.now ?? null);
      if (!now) throw new Error('The account usage clock is unavailable.');
      const account = rows<UsageRow>(await manager.query(`
        SELECT u."id", u."account_kind", u."is_active", u."expires_at", l."daily_credit_limit_units"::text,
          l."lifetime_credit_limit_units"::text, l."demo_credit_limits_configured", l."credit_timezone",
          l."pending_credit_timezone", l."timezone_effective_at", l."timezone_started_at",
          COALESCE(t."settled_units", 0)::text AS "lifetime_settled", COALESCE(t."reserved_units", 0)::text AS "lifetime_reserved",
          p."inference_paused", p."demo_daily_limit_units"::text, p."demo_campaign_limit_units"::text, p."demo_campaign_id"
        FROM "users" u JOIN "account_limits" l ON l."owner_id" = u."id"
        LEFT JOIN "credit_account_totals" t ON t."owner_id" = u."id"
        CROSS JOIN "credit_runtime_policy" p WHERE u."id" = $1 AND p."id" = 1
      `, [ownerId]))[0];
      if (!account) throw new AppError('USAGE_UNAVAILABLE', 503, 'Account usage is unavailable.');
      const effectiveAt = asDate(account.timezone_effective_at);
      const pendingApplies = Boolean(account.pending_credit_timezone && effectiveAt && effectiveAt <= now);
      const timezone = pendingApplies ? account.pending_credit_timezone! : account.credit_timezone;
      const timezoneStartedAt = pendingApplies ? effectiveAt : asDate(account.timezone_started_at);
      const accountWindow = creditDailyWindowAt(now, timezone, timezoneStartedAt);
      const dailyRows = rows<{ settled_units: string; reserved_units: string }>(await manager.query(`
        SELECT "settled_units"::text, "reserved_units"::text FROM "credit_account_daily_windows"
        WHERE "owner_id" = $1 AND "window_start" = $2
      `, [ownerId, accountWindow.startsAt]));
      const daily = dailyRows[0] ?? { settled_units: '0', reserved_units: '0' };
      const utcWindow = utcDailyWindowAt(now);
      let globalDaily = { settled_units: '0', reserved_units: '0' };
      let campaign = { settled_units: '0', reserved_units: '0' };
      if (account.account_kind === 'demo') {
        const demoRows = rows<typeof globalDaily>(await manager.query(`SELECT "settled_units"::text, "reserved_units"::text
          FROM "credit_demo_daily_windows" WHERE "window_start" = $1`, [utcWindow.startsAt]));
        globalDaily = demoRows[0] ?? globalDaily;
        if (account.demo_campaign_id) {
          const campaignRows = rows<typeof campaign>(await manager.query(`SELECT "settled_units"::text, "reserved_units"::text
            FROM "credit_demo_campaign_usage" WHERE "campaign_id" = $1`, [account.demo_campaign_id]));
          campaign = campaignRows[0] ?? campaign;
        }
      }
      const settled = daily.settled_units;
      const reserved = daily.reserved_units;
      let status: 'available' | 'exhausted' | 'paused' | 'unknown' = 'available';
      let reason: string | null = null;
      if (account.inference_paused) { status = 'paused'; reason = 'AI inference is paused for all accounts by an administrator.'; }
      else if (account.account_kind === 'demo' && !account.demo_credit_limits_configured) { status = 'unknown'; reason = 'Demo credit allowances are not configured.'; }
      else if (account.account_kind === 'demo' && (account.demo_daily_limit_units === null || account.demo_campaign_limit_units === null || !account.demo_campaign_id)) {
        status = 'unknown'; reason = 'Shared demo AI budgets are not configured.';
      } else if (remaining(account.daily_credit_limit_units, settled, reserved) === '0'
        || remaining(account.lifetime_credit_limit_units, account.lifetime_settled ?? '0', account.lifetime_reserved ?? '0') === '0'
        || (account.account_kind === 'demo' && (remaining(account.demo_daily_limit_units, globalDaily.settled_units, globalDaily.reserved_units) === '0'
          || remaining(account.demo_campaign_limit_units, campaign.settled_units, campaign.reserved_units) === '0'))) {
        status = 'exhausted'; reason = 'An AI usage allowance has been reached.';
      }
      if (!account.is_active || (account.expires_at !== null && asDate(account.expires_at)! <= now)) {
        status = 'unknown'; reason = 'This account is unavailable.';
      }
      const lifetimeLimit = account.lifetime_credit_limit_units;
      return {
        asOf: now.toISOString(), expiresAt: asDate(account.expires_at)?.toISOString() ?? null,
        daily: { ...creditSummary(account.daily_credit_limit_units, settled, reserved), resetAt: accountWindow.endsAt.toISOString(), timeZone: timezone },
        lifetime: { ...creditSummary(lifetimeLimit, account.lifetime_settled ?? '0', account.lifetime_reserved ?? '0') },
        availability: { status, reason, canSubmit: status === 'available' }
      };
    });
  }

  public async getDemoSettings(): Promise<unknown> {
    const [policy] = rows<PolicyRow>(await this.dataSource.query('SELECT * FROM "credit_runtime_policy" WHERE "id" = 1'));
    if (!policy) throw new AppError('POLICY_UNAVAILABLE', 503, 'Demo settings are unavailable.');
    const day = rows<{ settled_units: string; reserved_units: string }>(await this.dataSource.query(`
      SELECT "settled_units"::text, "reserved_units"::text FROM "credit_demo_daily_windows"
      WHERE "window_start" = date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    `))[0] ?? { settled_units: '0', reserved_units: '0' };
    const campaign = policy.demo_campaign_id ? rows<{ settled_units: string; reserved_units: string }>(await this.dataSource.query(`
      SELECT "settled_units"::text, "reserved_units"::text FROM "credit_demo_campaign_usage" WHERE "campaign_id" = $1
    `, [policy.demo_campaign_id]))[0] : undefined;
    return toPolicyDto(policy, { settled: day.settled_units, reserved: day.reserved_units },
      { settled: campaign?.settled_units ?? '0', reserved: campaign?.reserved_units ?? '0' });
  }

  public async updateDemoSettings(actorId: string, input: DemoSettingsInput): Promise<unknown> {
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lockPolicy(manager);
      await this.lockAdmin(manager, actorId);
      if (Number(current.revision) !== input.expectedRevision) throw conflict();
      if (current.demo_campaign_id !== null && input.campaignId !== current.demo_campaign_id) {
        throw new AppError('DEMO_CAMPAIGN_ID_IMMUTABLE', 409, 'The configured campaign ID cannot be changed or cleared.');
      }
      const old = this.safePolicyValues(current);
      const result = rows<PolicyRow>(await manager.query(`
        UPDATE "credit_runtime_policy" SET
          "demo_default_daily_limit_units" = $1, "demo_default_lifetime_limit_units" = $2, "demo_session_ttl_hours" = $3,
          "demo_global_admission_max" = $4, "demo_global_admission_window_seconds" = $5,
          "demo_network_admission_max" = $6, "demo_network_admission_window_seconds" = $7,
          "demo_run_start_max" = $8, "demo_run_start_window_seconds" = $9, "demo_max_concurrent_calls" = $10,
          "demo_daily_limit_units" = $11, "demo_campaign_id" = $12, "demo_campaign_limit_units" = $13,
          "inference_paused" = $14, "demo_settings_bootstrapped" = true,
          "revision" = "revision" + 1, "updated_at" = clock_timestamp()
        WHERE "id" = 1 AND "revision" = $15 RETURNING *
      `, [input.defaultDailyLimitUnits, input.defaultLifetimeLimitUnits, input.sessionTtlHours,
        input.globalAdmissionMax, input.globalAdmissionWindowSeconds, input.networkAdmissionMax, input.networkAdmissionWindowSeconds,
        input.runStartMax, input.runStartWindowSeconds, input.maxConcurrentCalls, input.globalDailyLimitUnits,
        input.campaignId, input.campaignLimitUnits, input.inferencePaused, input.expectedRevision]));
      const updated = result[0];
      if (!updated) throw conflict();
      await this.audit(manager, actorId, 'demo.settings_updated', null, old, this.safePolicyValues(updated));
      const day = rows<{ settled_units: string; reserved_units: string }>(await manager.query(`
        SELECT "settled_units"::text, "reserved_units"::text FROM "credit_demo_daily_windows"
        WHERE "window_start" = date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      `))[0] ?? { settled_units: '0', reserved_units: '0' };
      const campaign = updated.demo_campaign_id ? rows<{ settled_units: string; reserved_units: string }>(await manager.query(
        'SELECT "settled_units"::text, "reserved_units"::text FROM "credit_demo_campaign_usage" WHERE "campaign_id" = $1', [updated.demo_campaign_id]))[0] : undefined;
      return toPolicyDto(updated, { settled: day.settled_units, reserved: day.reserved_units },
        { settled: campaign?.settled_units ?? '0', reserved: campaign?.reserved_units ?? '0' });
    });
  }

  public async listAudit(limit: number): Promise<unknown> {
    const found = rows<{ id: string; actor_name: string | null; action: string; target_account_id: string | null;
      old_values: Record<string, unknown>; new_values: Record<string, unknown>; created_at: Date | string }>(await this.dataSource.query(`
      SELECT e."id", u."display_name" AS "actor_name", e."action", e."target_account_id", e."old_values", e."new_values", e."created_at"
      FROM "admin_audit_events" e LEFT JOIN "users" u ON u."id" = e."actor_id"
      ORDER BY e."created_at" DESC, e."id" DESC LIMIT $1
    `, [limit]));
    return { events: found.map((event) => ({ id: event.id, actorName: event.actor_name, action: event.action,
      target_account_id: event.target_account_id, old_values: event.old_values, new_values: event.new_values,
      createdAt: asDate(event.created_at)?.toISOString() ?? null })) };
  }

  public async createAccount(actorId: string, input: { displayName: string; identifier: string; passwordHash: string }): Promise<unknown> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await this.lockPolicy(manager);
        await this.lockAdmin(manager, actorId);
        const inserted = rows<{ id: string; display_name: string; identifier: string }>(await manager.query(`
          INSERT INTO "users" ("scope_key", "identifier", "account_kind", "role", "display_name", "password_hash")
          VALUES ('account:' || replace(gen_random_uuid()::text, '-', ''), $1, 'regular', 'user', $2, $3)
          RETURNING "id", "display_name", "identifier"
        `, [input.identifier, input.displayName, input.passwordHash]))[0];
        if (!inserted) throw new AppError('ADMIN_UNAVAILABLE', 503, 'The account could not be created.');
        await manager.query('INSERT INTO "account_limits" ("owner_id") VALUES ($1)', [inserted.id]);
        await manager.query('INSERT INTO "credit_account_totals" ("owner_id") VALUES ($1)', [inserted.id]);
        await manager.query('INSERT INTO "storage_account_totals" ("owner_id", "accounting_state") VALUES ($1, \'reconciling\')', [inserted.id]);
        await this.audit(manager, actorId, 'account.created', inserted.id, {}, { accountKind: 'regular', role: 'user' });
        return { account: { id: inserted.id, displayName: inserted.display_name, identifier: inserted.identifier, accountKind: 'regular', role: 'user', enabled: true } };
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new AppError('ACCOUNT_IDENTIFIER_CONFLICT', 409, 'An account with that identifier already exists.');
      throw error;
    }
  }

  public async updateAccountLimits(actorId: string, accountId: string, input: AccountLimitsInput): Promise<unknown> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockPolicy(manager);
      await this.lockAdmin(manager, actorId);
      const target = await this.lockTarget(manager, accountId);
      const limits = rows<{ limits_revision: string; daily_credit_limit_units: string | null; lifetime_credit_limit_units: string | null;
        storage_limit_bytes: string | null; demo_credit_limits_configured: boolean }>(await manager.query('SELECT "limits_revision", "daily_credit_limit_units"::text, "lifetime_credit_limit_units"::text, "storage_limit_bytes"::text, "demo_credit_limits_configured" FROM "account_limits" WHERE "owner_id" = $1 FOR UPDATE', [accountId]))[0];
      if (!limits) throw accountNotFound();
      if (Number(limits.limits_revision) !== input.expectedRevision) throw conflict();
      const updated = rows<{ limits_revision: string }>(await manager.query(`
        UPDATE "account_limits" SET "daily_credit_limit_units" = $2::bigint, "lifetime_credit_limit_units" = $3::bigint,
          "storage_limit_bytes" = $4::bigint,
          "demo_credit_limits_configured" = CASE WHEN $5::text = 'demo'
            THEN ("demo_credit_limits_configured" OR $2::bigint IS NOT NULL OR $3::bigint IS NOT NULL)
            ELSE "demo_credit_limits_configured" END,
          "limits_revision" = "limits_revision" + 1, "updated_at" = clock_timestamp()
        WHERE "owner_id" = $1 AND "limits_revision" = $6::bigint RETURNING "limits_revision"
      `, [accountId, input.dailyCreditLimitUnits, input.lifetimeCreditLimitUnits, input.storageLimitBytes, target.account_kind, input.expectedRevision]))[0];
      if (!updated) throw conflict();
      await this.audit(manager, actorId, 'account.limits_updated', accountId,
        { dailyCreditLimitUnits: limits.daily_credit_limit_units, lifetimeCreditLimitUnits: limits.lifetime_credit_limit_units,
          storageLimitBytes: limits.storage_limit_bytes, demoCreditLimitsConfigured: limits.demo_credit_limits_configured },
        { dailyCreditLimitUnits: input.dailyCreditLimitUnits, lifetimeCreditLimitUnits: input.lifetimeCreditLimitUnits,
          storageLimitBytes: input.storageLimitBytes,
          demoCreditLimitsConfigured: target.account_kind === 'demo' ? limits.demo_credit_limits_configured
            || input.dailyCreditLimitUnits !== null || input.lifetimeCreditLimitUnits !== null : limits.demo_credit_limits_configured });
      return { accountId: target.id, limitsRevision: Number(updated.limits_revision) };
    });
  }

  public async setAccountEnabled(actorId: string, accountId: string, enabled: boolean): Promise<unknown> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockPolicy(manager);
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('account-admin-status')::bigint)");
      await this.lockAdmin(manager, actorId);
      const target = await this.lockTarget(manager, accountId);
      if (!enabled && target.is_active && target.role === 'admin') {
        const active = rows<{ count: string }>(await manager.query('SELECT count(*)::text AS "count" FROM "users" WHERE "role" = \'admin\' AND "is_active" = true'))[0];
        if (Number(active?.count ?? 0) <= 1) throw new AppError('LAST_ACTIVE_ADMIN', 409, 'Keep at least one active administrator.');
      }
      await manager.query('UPDATE "users" SET "is_active" = $2, "updated_at" = clock_timestamp() WHERE "id" = $1', [accountId, enabled]);
      if (!enabled) await this.revokeSessionsIn(manager, accountId);
      await this.audit(manager, actorId, enabled ? 'account.enabled' : 'account.disabled', accountId,
        { enabled: target.is_active }, { enabled });
      return { accountId, enabled };
    });
  }

  public async resetPassword(actorId: string, accountId: string, passwordHash: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.lockPolicy(manager);
      await this.lockAdmin(manager, actorId);
      await this.lockTarget(manager, accountId);
      await manager.query('UPDATE "users" SET "password_hash" = $2, "updated_at" = clock_timestamp() WHERE "id" = $1', [accountId, passwordHash]);
      await this.revokeSessionsIn(manager, accountId);
      await this.audit(manager, actorId, 'account.password_reset', accountId, {}, { allSessionsRevoked: true });
    });
  }

  public async revokeSessions(actorId: string, accountId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.lockPolicy(manager);
      await this.lockAdmin(manager, actorId);
      await this.lockTarget(manager, accountId);
      const revoked = await this.revokeSessionsIn(manager, accountId);
      await this.audit(manager, actorId, 'account.sessions_revoked', accountId, {}, { revokedSessionCount: revoked });
    });
  }

  private async lockPolicy(manager: Queryable): Promise<PolicyRow> {
    const policy = rows<PolicyRow>(await manager.query('SELECT * FROM "credit_runtime_policy" WHERE "id" = 1 FOR UPDATE'))[0];
    if (!policy) throw new AppError('POLICY_UNAVAILABLE', 503, 'Demo settings are unavailable.');
    return policy;
  }

  private async lockAdmin(manager: Queryable, actorId: string): Promise<void> {
    const actors = rows<{ id: string }>(await manager.query('SELECT "id" FROM "users" WHERE "id" = $1 AND "role" = \'admin\' AND "account_kind" = \'regular\' AND "is_active" = true FOR UPDATE', [actorId]));
    if (!actors[0]) throw new AppError('ADMIN_REQUIRED', 403, 'An administrator session is required.');
  }

  private async lockTarget(manager: Queryable, accountId: string): Promise<{ id: string; is_active: boolean; role: 'user' | 'admin'; account_kind: 'regular' | 'demo' }> {
    const target = rows<{ id: string; is_active: boolean; role: 'user' | 'admin'; account_kind: 'regular' | 'demo' }>(await manager.query('SELECT "id", "is_active", "role", "account_kind" FROM "users" WHERE "id" = $1 FOR UPDATE', [accountId]))[0];
    if (!target) throw accountNotFound();
    return target;
  }

  private async revokeSessionsIn(manager: Queryable, accountId: string): Promise<number> {
    const revoked = rows<{ id: string }>(await manager.query('UPDATE "sessions" SET "revoked_at" = COALESCE("revoked_at", clock_timestamp()), "updated_at" = clock_timestamp() WHERE "user_id" = $1 AND "revoked_at" IS NULL RETURNING "id"', [accountId]));
    return revoked.length;
  }

  private async audit(manager: Queryable, actorId: string, action: string, targetId: string | null,
    oldValues: Record<string, unknown>, newValues: Record<string, unknown>): Promise<void> {
    await manager.query('INSERT INTO "admin_audit_events" ("actor_id", "action", "target_account_id", "old_values", "new_values") VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)',
      [actorId, action, targetId, JSON.stringify(oldValues), JSON.stringify(newValues)]);
  }

  private safePolicyValues(policy: PolicyRow): Record<string, unknown> {
    return {
      defaultDailyLimitUnits: policy.demo_default_daily_limit_units, defaultLifetimeLimitUnits: policy.demo_default_lifetime_limit_units,
      sessionTtlHours: policy.demo_session_ttl_hours, globalAdmissionMax: policy.demo_global_admission_max,
      globalAdmissionWindowSeconds: policy.demo_global_admission_window_seconds, networkAdmissionMax: policy.demo_network_admission_max,
      networkAdmissionWindowSeconds: policy.demo_network_admission_window_seconds, runStartMax: policy.demo_run_start_max,
      runStartWindowSeconds: policy.demo_run_start_window_seconds, maxConcurrentCalls: policy.demo_max_concurrent_calls,
      globalDailyLimitUnits: policy.demo_daily_limit_units, campaignId: policy.demo_campaign_id,
      campaignLimitUnits: policy.demo_campaign_limit_units, inferencePaused: policy.inference_paused
    };
  }
}

function accountNotFound(): AppError { return new AppError('ACCOUNT_NOT_FOUND', 404, 'The account was not found.'); }
function conflict(): AppError { return new AppError('ADMIN_REVISION_CONFLICT', 409, 'These settings changed. Reload the latest values and try again.'); }
function isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505'); }
