import type { DataSource, QueryRunner } from 'typeorm';
import { canonicalCreditTimeZone, creditDailyWindowAt, nextCreditTimeZoneChangeBoundary, utcDailyWindowAt } from '@/modules/credits/domain/credit-time-windows';
import { ProviderCreditAdmissionDeniedError } from '@/modules/credits/domain/credit-errors';
import { creditUnitsForUsage, POSTGRES_BIGINT_MAX } from '@/modules/credits/domain/credit-calculation';
import type { ICreditLedgerRepository, CreditReservationCommand, CreditSettlementCommand, AccountTimeZoneChangeCommand } from '@/modules/credits/repositories/credit-ledger-repository';
import type { CreditCallSourceKind, ProviderCallCreditReservation, ProviderCallSettlementResult } from '@/modules/credits/repositories/provider-call-credit-admission';
import type { CreditDenialReason } from '@/modules/credits/domain/credit-errors';

interface UserCreditRow {
  id: string;
  account_kind: 'regular' | 'demo';
  is_active: boolean;
  expires_at: Date | string | null;
}

interface AccountLimitsRow {
  daily_credit_limit_units: string | null;
  lifetime_credit_limit_units: string | null;
  demo_credit_limits_configured: boolean;
  credit_timezone: string;
  pending_credit_timezone: string | null;
  timezone_effective_at: Date | string | null;
  timezone_started_at: Date | string | null;
  max_concurrent_inference_calls: number;
}

interface CounterRow {
  settled_units: string;
  reserved_units: string;
}

interface PolicyRow {
  inference_paused: boolean;
  demo_daily_limit_units: string | null;
  demo_campaign_limit_units: string | null;
  demo_campaign_id: string | null;
  demo_max_concurrent_calls: number;
}

interface ReservationRow {
  id: string;
  owner_id: string | null;
  account_kind: 'regular' | 'demo';
  source_kind: CreditCallSourceKind;
  source_id: string;
  call_id: string;
  attempt_id: string;
  input_units_per_million_tokens: string;
  output_units_per_million_tokens: string;
  price_version: string;
  reserved_units: string;
  account_window_start: Date | string;
  demo_window_start: Date | string | null;
  demo_campaign_id: string | null;
  status: 'in_flight' | 'unknown' | 'settled' | 'released' | 'over_bound';
  charged_units: string | null;
  max_input_tokens: string;
  max_output_tokens: string;
}

/**
 * All mutating operations take the same short-lived locks in contract order.
 * The singleton policy lock serializes budget admission without holding a lock
 * across provider or filesystem work.
 */
export class TypeOrmCreditLedgerRepository implements ICreditLedgerRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async reserveProviderCall(command: CreditReservationCommand): Promise<ProviderCallCreditReservation> {
    return this.inTransaction(async (runner) => {
      const policy = await this.lockPolicy(runner);
      if (policy.inference_paused) throw denied('paused');

      const user = await this.lockActiveUser(runner, command.ownerId);
      const limits = await this.lockLimits(runner, command.ownerId);
      const databaseNow = await this.databaseNow(runner);
      const activeLimits = await this.applyPendingTimeZone(runner, command.ownerId, limits, databaseNow);

      if (user.account_kind === 'demo' && !activeLimits.demo_credit_limits_configured) throw denied('unconfigured');
      if (user.account_kind === 'demo'
        && (policy.demo_daily_limit_units === null || policy.demo_campaign_limit_units === null || policy.demo_campaign_id === null)) {
        throw denied('unconfigured');
      }

      await this.ensureAccountTotal(runner, command.ownerId);
      const accountTotal = await this.lockAccountTotal(runner, command.ownerId);
      const accountWindow = creditDailyWindowAt(databaseNow, activeLimits.credit_timezone, toDate(activeLimits.timezone_started_at));
      await this.ensureAccountWindow(runner, command.ownerId, accountWindow);
      const accountDaily = await this.lockAccountWindow(runner, command.ownerId, accountWindow.startsAt);

      let demoWindow: ReturnType<typeof utcDailyWindowAt> | undefined;
      let demoDaily: CounterRow | undefined;
      let demoCampaign: CounterRow | undefined;
      if (user.account_kind === 'demo') {
        demoWindow = utcDailyWindowAt(databaseNow);
        await this.ensureDemoDailyWindow(runner, demoWindow);
        demoDaily = await this.lockDemoDailyWindow(runner, demoWindow.startsAt);
        await this.ensureDemoCampaign(runner, policy.demo_campaign_id!);
        demoCampaign = await this.lockDemoCampaign(runner, policy.demo_campaign_id!);
      }

      const duplicate = await runner.query(
        `SELECT "id" FROM "credit_provider_call_reservations"
         WHERE "owner_id" = $1 AND "source_kind" = $2 AND "source_id" = $3
           AND "call_id" = $4 AND "attempt_id" = $5`,
        [command.ownerId, command.sourceKind, command.sourceId, command.callId, command.attemptId]
      );
      if (duplicate.length > 0) throw denied('duplicate_attempt');

      const budget = await this.lockRunBudget(runner, command);
      if (budget.admitted_attempts >= budget.max_attempts || budget.max_attempts !== command.maxAttemptsForSource) {
        throw denied('call_limit_exceeded');
      }

      const activeCalls = await runner.query(
        `SELECT count(*)::integer AS "count" FROM "credit_provider_call_reservations"
         WHERE "owner_id" = $1 AND "status" IN ('in_flight', 'unknown')`,
        [command.ownerId]
      );
      const activeCallCount = Number(activeCalls[0]?.count ?? 0);
      const maxConcurrent = user.account_kind === 'demo'
        ? Math.min(activeLimits.max_concurrent_inference_calls, policy.demo_max_concurrent_calls)
        : activeLimits.max_concurrent_inference_calls;
      if (activeCallCount >= maxConcurrent) throw denied('call_limit_exceeded');

      enforceLimit(activeLimits.lifetime_credit_limit_units, accountTotal, command.maximumUnits);
      enforceLimit(activeLimits.daily_credit_limit_units, accountDaily, command.maximumUnits);
      if (demoDaily && demoCampaign && policy.demo_daily_limit_units !== null && policy.demo_campaign_limit_units !== null) {
        enforceLimit(policy.demo_daily_limit_units, demoDaily, command.maximumUnits);
        enforceLimit(policy.demo_campaign_limit_units, demoCampaign, command.maximumUnits);
      }

      const inserted = await runner.query(
        `INSERT INTO "credit_provider_call_reservations" (
           "owner_id", "account_kind", "source_kind", "source_id", "call_id", "attempt_id",
           "provider_profile", "provider_model", "price_version", "input_units_per_million_tokens",
           "output_units_per_million_tokens", "input_bounder_version", "max_input_tokens", "max_output_tokens",
           "reserved_units", "account_window_start", "demo_window_start", "demo_campaign_id", "status"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'in_flight')
         RETURNING "id"`,
        [
          command.ownerId, user.account_kind, command.sourceKind, command.sourceId, command.callId, command.attemptId,
          command.providerProfile, command.model, command.price.version, command.price.inputUnitsPerMillionTokens.toString(),
          command.price.outputUnitsPerMillionTokens.toString(), command.inputBounderVersion, command.maxInputTokens,
          command.maxOutputTokens, command.maximumUnits.toString(), accountWindow.startsAt,
          demoWindow?.startsAt ?? null, user.account_kind === 'demo' ? policy.demo_campaign_id : null
        ]
      );

      await runner.query(
        `UPDATE "credit_provider_run_budgets" SET "admitted_attempts" = "admitted_attempts" + 1
         WHERE "owner_id" = $1 AND "source_kind" = $2 AND "source_id" = $3`,
        [command.ownerId, command.sourceKind, command.sourceId]
      );
      await this.addReserved(runner, 'credit_account_totals', { owner_id: command.ownerId }, command.maximumUnits);
      await this.addReserved(runner, 'credit_account_daily_windows', { owner_id: command.ownerId, window_start: accountWindow.startsAt }, command.maximumUnits);
      if (demoWindow && policy.demo_campaign_id) {
        await this.addReserved(runner, 'credit_demo_daily_windows', { window_start: demoWindow.startsAt }, command.maximumUnits);
        await this.addReserved(runner, 'credit_demo_campaign_usage', { campaign_id: policy.demo_campaign_id }, command.maximumUnits);
      }

      return { reservationId: String(inserted[0].id), maximumUnits: command.maximumUnits };
    });
  }

  public async settleProviderCall(command: CreditSettlementCommand): Promise<ProviderCallSettlementResult> {
    const { promptTokens, completionTokens, totalTokens } = command.usage;
    if (!Number.isSafeInteger(promptTokens) || promptTokens === undefined || promptTokens < 0
      || !Number.isSafeInteger(completionTokens) || completionTokens === undefined || completionTokens < 0) {
      throw new Error('Validated provider usage is required.');
    }
    const actualTotalTokens = promptTokens + completionTokens;
    if (!Number.isSafeInteger(actualTotalTokens)
      || (totalTokens !== undefined && (!Number.isSafeInteger(totalTokens) || totalTokens !== actualTotalTokens))) {
      throw new Error('Provider usage totals are inconsistent.');
    }

    return this.inTransaction(async (runner) => {
      await this.lockPolicy(runner);
      const metadata = await this.findReservation(runner, command.reservationId, false);
      if (!metadata) throw new Error('The provider call reservation does not exist.');
      if (metadata.status === 'settled' || metadata.status === 'over_bound') {
        return { outcome: 'replayed', chargedUnits: BigInt(metadata.charged_units ?? '0') };
      }
      if (metadata.owner_id === null) throw new Error('A detached provider reservation cannot be settled.');
      await this.lockUser(runner, metadata.owner_id);
      await this.lockLimits(runner, metadata.owner_id);
      await this.ensureAccountTotal(runner, metadata.owner_id);
      await this.lockAccountTotal(runner, metadata.owner_id);
      await this.lockAccountWindow(runner, metadata.owner_id, toDate(metadata.account_window_start)!);
      if (metadata.account_kind === 'demo') {
        await this.lockDemoDailyWindow(runner, toDate(metadata.demo_window_start)!);
        await this.lockDemoCampaign(runner, metadata.demo_campaign_id!);
      }
      const reservation = await this.findReservation(runner, command.reservationId, true);
      if (!reservation) throw new Error('The provider call reservation does not exist.');
      if (reservation.owner_id === null) throw new Error('The provider call owner was detached before settlement.');
      if (reservation.status === 'settled' || reservation.status === 'over_bound') {
        return { outcome: 'replayed', chargedUnits: BigInt(reservation.charged_units ?? '0') };
      }
      if (reservation.status === 'released') throw new Error('A released reservation cannot be settled.');
      const inputTokens = promptTokens;
      const outputTokens = completionTokens;
      const charged = creditUnitsForUsage(
        { inputTokens, outputTokens },
        {
          inputUnitsPerMillionTokens: BigInt(reservation.input_units_per_million_tokens),
          outputUnitsPerMillionTokens: BigInt(reservation.output_units_per_million_tokens)
        }
      );
      const reserved = BigInt(reservation.reserved_units);
      if (charged > POSTGRES_BIGINT_MAX) {
        await runner.query(
          `UPDATE "credit_provider_call_reservations"
           SET "status" = 'unknown', "actual_input_tokens" = $2, "actual_output_tokens" = $3,
               "unknown_reason" = 'usage_charge_overflow'
           WHERE "id" = $1`,
          [reservation.id, inputTokens, outputTokens]
        );
        await runner.query(
          'UPDATE "credit_runtime_policy" SET "inference_paused" = true, "revision" = "revision" + 1, "updated_at" = clock_timestamp() WHERE "id" = 1 AND "inference_paused" = false'
        );
        return { outcome: 'unknown', reason: 'usage_charge_overflow' };
      }
      const exceededTokenBound = inputTokens > Number(reservation.max_input_tokens) || outputTokens > Number(reservation.max_output_tokens);
      const exceededReservation = charged > reserved;
      const status = exceededTokenBound || exceededReservation ? 'over_bound' : 'settled';

      await runner.query(
        `INSERT INTO "credit_usage_entries" (
           "reservation_id", "owner_id", "source_kind", "source_id", "call_id", "attempt_id",
           "input_tokens", "output_tokens", "total_tokens", "price_version",
           "input_units_per_million_tokens", "output_units_per_million_tokens", "charged_units"
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT ("reservation_id") DO NOTHING`,
        [
          reservation.id, reservation.owner_id, reservation.source_kind, reservation.source_id,
          reservation.call_id, reservation.attempt_id, inputTokens, outputTokens, actualTotalTokens,
          reservation.price_version, reservation.input_units_per_million_tokens,
          reservation.output_units_per_million_tokens, charged.toString()
        ]
      );
      await this.consumeReserved(runner, 'credit_account_totals', { owner_id: reservation.owner_id }, reserved, charged);
      await this.consumeReserved(runner, 'credit_account_daily_windows', { owner_id: reservation.owner_id, window_start: reservation.account_window_start }, reserved, charged);
      if (reservation.account_kind === 'demo') {
        await this.consumeReserved(runner, 'credit_demo_daily_windows', { window_start: reservation.demo_window_start! }, reserved, charged);
        await this.consumeReserved(runner, 'credit_demo_campaign_usage', { campaign_id: reservation.demo_campaign_id! }, reserved, charged);
      }
      await runner.query(
        `UPDATE "credit_provider_call_reservations"
         SET "status" = $2, "actual_input_tokens" = $3, "actual_output_tokens" = $4,
             "charged_units" = $5, "settled_at" = clock_timestamp(), "unknown_reason" = NULL
         WHERE "id" = $1`,
        [reservation.id, status, inputTokens, outputTokens, charged.toString()]
      );
      if (status === 'over_bound') {
        await runner.query('UPDATE "credit_runtime_policy" SET "inference_paused" = true, "revision" = "revision" + 1, "updated_at" = clock_timestamp() WHERE "id" = 1');
      }
      return { outcome: status, chargedUnits: charged };
    });
  }

  public async retainUnknown(reservationId: string, reason: string): Promise<void> {
    await this.inTransaction(async (runner) => {
      const reservation = await this.lockReservationScope(runner, reservationId);
      if (reservation.status === 'in_flight') {
        await runner.query(
          `UPDATE "credit_provider_call_reservations" SET "status" = 'unknown', "unknown_reason" = $2 WHERE "id" = $1`,
          [reservationId, safeUnknownReason(reason)]
        );
      }
    });
  }

  public async releaseKnownNotSent(reservationId: string): Promise<void> {
    await this.inTransaction(async (runner) => {
      const reservation = await this.lockReservationScope(runner, reservationId);
      if (reservation.status === 'released') return;
      if (reservation.status !== 'in_flight') throw new Error('Only a provider call known not to have been sent can be released.');
      if (reservation.owner_id === null) throw new Error('An in-flight provider reservation must retain its owner.');
      const amount = BigInt(reservation.reserved_units);
      await this.releaseReserved(runner, 'credit_account_totals', { owner_id: reservation.owner_id }, amount);
      await this.releaseReserved(runner, 'credit_account_daily_windows', { owner_id: reservation.owner_id, window_start: reservation.account_window_start }, amount);
      if (reservation.account_kind === 'demo') {
        await this.releaseReserved(runner, 'credit_demo_daily_windows', { window_start: reservation.demo_window_start! }, amount);
        await this.releaseReserved(runner, 'credit_demo_campaign_usage', { campaign_id: reservation.demo_campaign_id! }, amount);
      }
      await runner.query(`UPDATE "credit_provider_call_reservations" SET "status" = 'released', "unknown_reason" = NULL WHERE "id" = $1`, [reservation.id]);
      await runner.query(
        `UPDATE "credit_provider_run_budgets" SET "admitted_attempts" = GREATEST(0, "admitted_attempts" - 1)
         WHERE "owner_id" = $1 AND "source_kind" = $2 AND "source_id" = $3`,
        [reservation.owner_id, reservation.source_kind, reservation.source_id]
      );
    });
  }

  public async queueAccountTimeZoneChange(command: AccountTimeZoneChangeCommand): Promise<Date> {
    return this.inTransaction(async (runner) => {
      await this.lockPolicy(runner);
      await this.lockUser(runner, command.ownerId);
      const limits = await this.lockLimits(runner, command.ownerId);
      const timeZone = canonicalCreditTimeZone(command.timeZone);
      const now = await this.databaseNow(runner);
      if (timeZone === limits.credit_timezone) {
        await runner.query(
          `UPDATE "account_limits" SET "pending_credit_timezone" = NULL, "timezone_effective_at" = NULL, "updated_at" = clock_timestamp() WHERE "owner_id" = $1`,
          [command.ownerId]
        );
        return now;
      }
      const effectiveAt = nextCreditTimeZoneChangeBoundary(now, limits.credit_timezone);
      await runner.query(
        `UPDATE "account_limits" SET "pending_credit_timezone" = $2, "timezone_effective_at" = $3, "updated_at" = clock_timestamp() WHERE "owner_id" = $1`,
        [command.ownerId, timeZone, effectiveAt]
      );
      return effectiveAt;
    });
  }

  private async lockReservationScope(runner: QueryRunner, reservationId: string): Promise<ReservationRow> {
    await this.lockPolicy(runner);
    const metadata = await this.findReservation(runner, reservationId, false);
    if (!metadata) throw new Error('The provider call reservation does not exist.');
    if (metadata.owner_id === null) {
      if (metadata.status === 'settled' || metadata.status === 'released' || metadata.status === 'over_bound') return metadata;
      throw new Error('An unresolved provider reservation cannot be detached from its owner.');
    }
    await this.lockUser(runner, metadata.owner_id);
    await this.lockLimits(runner, metadata.owner_id);
    await this.ensureAccountTotal(runner, metadata.owner_id);
    await this.lockAccountTotal(runner, metadata.owner_id);
    await this.lockAccountWindow(runner, metadata.owner_id, toDate(metadata.account_window_start)!);
    if (metadata.account_kind === 'demo') {
      await this.lockDemoDailyWindow(runner, toDate(metadata.demo_window_start)!);
      await this.lockDemoCampaign(runner, metadata.demo_campaign_id!);
    }
    const locked = await this.findReservation(runner, reservationId, true);
    if (!locked) throw new Error('The provider call reservation does not exist.');
    return locked;
  }

  private async lockPolicy(runner: QueryRunner): Promise<PolicyRow> {
    const rows: PolicyRow[] = await runner.query('SELECT * FROM "credit_runtime_policy" WHERE "id" = 1 FOR UPDATE');
    if (!rows[0]) throw denied('unconfigured');
    return rows[0];
  }

  private async lockActiveUser(runner: QueryRunner, ownerId: string): Promise<UserCreditRow> {
    const rows: UserCreditRow[] = await runner.query(
      `SELECT "id", "account_kind", "is_active", "expires_at" FROM "users" WHERE "id" = $1 FOR UPDATE`,
      [ownerId]
    );
    const user = rows[0];
    const now = await this.databaseNow(runner);
    if (!user || !user.is_active || (user.expires_at !== null && toDate(user.expires_at)!.getTime() <= now.getTime())) {
      throw denied('account_inactive');
    }
    return user;
  }

  private async lockUser(runner: QueryRunner, ownerId: string): Promise<void> {
    const rows: readonly { readonly id: string }[] = await runner.query('SELECT "id" FROM "users" WHERE "id" = $1 FOR UPDATE', [ownerId]);
    if (!rows[0]) throw denied('account_inactive');
  }

  private async lockLimits(runner: QueryRunner, ownerId: string): Promise<AccountLimitsRow> {
    await runner.query('INSERT INTO "account_limits" ("owner_id") VALUES ($1) ON CONFLICT ("owner_id") DO NOTHING', [ownerId]);
    const rows: AccountLimitsRow[] = await runner.query('SELECT * FROM "account_limits" WHERE "owner_id" = $1 FOR UPDATE', [ownerId]);
    if (!rows[0]) throw denied('account_inactive');
    return rows[0];
  }

  private async applyPendingTimeZone(runner: QueryRunner, ownerId: string, limits: AccountLimitsRow, now: Date): Promise<AccountLimitsRow> {
    const effectiveAt = toDate(limits.timezone_effective_at);
    if (!limits.pending_credit_timezone || !effectiveAt || effectiveAt.getTime() > now.getTime()) return limits;
    await runner.query(
      `UPDATE "account_limits" SET "credit_timezone" = "pending_credit_timezone",
         "timezone_started_at" = "timezone_effective_at", "pending_credit_timezone" = NULL,
         "timezone_effective_at" = NULL, "updated_at" = clock_timestamp() WHERE "owner_id" = $1`,
      [ownerId]
    );
    return {
      ...limits,
      credit_timezone: limits.pending_credit_timezone,
      timezone_started_at: effectiveAt,
      pending_credit_timezone: null,
      timezone_effective_at: null
    };
  }

  private async databaseNow(runner: QueryRunner): Promise<Date> {
    const rows: { now: Date | string }[] = await runner.query('SELECT clock_timestamp() AS "now"');
    return toDate(rows[0]?.now)!;
  }

  private async ensureAccountTotal(runner: QueryRunner, ownerId: string): Promise<void> {
    await runner.query('INSERT INTO "credit_account_totals" ("owner_id") VALUES ($1) ON CONFLICT ("owner_id") DO NOTHING', [ownerId]);
  }

  private async lockAccountTotal(runner: QueryRunner, ownerId: string): Promise<CounterRow> {
    const rows: CounterRow[] = await runner.query('SELECT "settled_units", "reserved_units" FROM "credit_account_totals" WHERE "owner_id" = $1 FOR UPDATE', [ownerId]);
    if (!rows[0]) throw new Error('The account usage row could not be locked.');
    return rows[0];
  }

  private async ensureAccountWindow(runner: QueryRunner, ownerId: string, window: { startsAt: Date; endsAt: Date; timeZone: string }): Promise<void> {
    await runner.query(
      `INSERT INTO "credit_account_daily_windows" ("owner_id", "window_start", "window_end", "timezone_name")
       VALUES ($1, $2, $3, $4) ON CONFLICT ("owner_id", "window_start") DO NOTHING`,
      [ownerId, window.startsAt, window.endsAt, window.timeZone]
    );
  }

  private async lockAccountWindow(runner: QueryRunner, ownerId: string, start: Date): Promise<CounterRow> {
    const rows: CounterRow[] = await runner.query(
      `SELECT "settled_units", "reserved_units" FROM "credit_account_daily_windows"
       WHERE "owner_id" = $1 AND "window_start" = $2 FOR UPDATE`, [ownerId, start]
    );
    if (!rows[0]) throw new Error('The account daily window could not be locked.');
    return rows[0];
  }

  private async ensureDemoDailyWindow(runner: QueryRunner, window: { startsAt: Date; endsAt: Date }): Promise<void> {
    await runner.query(
      `INSERT INTO "credit_demo_daily_windows" ("window_start", "window_end") VALUES ($1, $2)
       ON CONFLICT ("window_start") DO NOTHING`,
      [window.startsAt, window.endsAt]
    );
  }

  private async lockDemoDailyWindow(runner: QueryRunner, start: Date): Promise<CounterRow> {
    const rows: CounterRow[] = await runner.query(
      `SELECT "settled_units", "reserved_units" FROM "credit_demo_daily_windows" WHERE "window_start" = $1 FOR UPDATE`, [start]
    );
    if (!rows[0]) throw new Error('The deployment demo daily window could not be locked.');
    return rows[0];
  }

  private async ensureDemoCampaign(runner: QueryRunner, campaignId: string): Promise<void> {
    await runner.query('INSERT INTO "credit_demo_campaign_usage" ("campaign_id") VALUES ($1) ON CONFLICT ("campaign_id") DO NOTHING', [campaignId]);
  }

  private async lockDemoCampaign(runner: QueryRunner, campaignId: string): Promise<CounterRow> {
    const rows: CounterRow[] = await runner.query(
      `SELECT "settled_units", "reserved_units" FROM "credit_demo_campaign_usage" WHERE "campaign_id" = $1 FOR UPDATE`, [campaignId]
    );
    if (!rows[0]) throw new Error('The deployment demo campaign could not be locked.');
    return rows[0];
  }

  private async lockRunBudget(runner: QueryRunner, command: CreditReservationCommand): Promise<{ max_attempts: number; admitted_attempts: number }> {
    await runner.query(
      `INSERT INTO "credit_provider_run_budgets" ("owner_id", "source_kind", "source_id", "max_attempts")
       VALUES ($1, $2, $3, $4) ON CONFLICT ("owner_id", "source_kind", "source_id") DO NOTHING`,
      [command.ownerId, command.sourceKind, command.sourceId, command.maxAttemptsForSource]
    );
    const rows: { max_attempts: number; admitted_attempts: number }[] = await runner.query(
      `SELECT "max_attempts", "admitted_attempts" FROM "credit_provider_run_budgets"
       WHERE "owner_id" = $1 AND "source_kind" = $2 AND "source_id" = $3 FOR UPDATE`,
      [command.ownerId, command.sourceKind, command.sourceId]
    );
    if (!rows[0]) throw new Error('The provider call budget could not be locked.');
    return rows[0];
  }

  private async findReservation(runner: QueryRunner, id: string, forUpdate: boolean): Promise<ReservationRow | undefined> {
    const rows: ReservationRow[] = await runner.query(
      `SELECT * FROM "credit_provider_call_reservations" WHERE "id" = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [id]
    );
    return rows[0];
  }

  private async addReserved(runner: QueryRunner, table: 'credit_account_totals' | 'credit_account_daily_windows' | 'credit_demo_daily_windows' | 'credit_demo_campaign_usage', keys: Record<string, string | Date>, amount: bigint): Promise<void> {
    const { predicate, values } = whereKeys(keys);
    const result = await runner.query(
      `UPDATE "${table}" SET "reserved_units" = "reserved_units" + $${values.length + 1}, "updated_at" = clock_timestamp()
       WHERE ${predicate} RETURNING "reserved_units"`,
      [...values, amount.toString()]
    );
    if (result.length === 0) throw new Error('The credit reservation counter could not be updated.');
  }

  private async consumeReserved(runner: QueryRunner, table: 'credit_account_totals' | 'credit_account_daily_windows' | 'credit_demo_daily_windows' | 'credit_demo_campaign_usage', keys: Record<string, string | Date>, reserved: bigint, charged: bigint): Promise<void> {
    const { predicate, values } = whereKeys(keys);
    const result = await runner.query(
      `UPDATE "${table}" SET "reserved_units" = "reserved_units" - $${values.length + 1},
         "settled_units" = "settled_units" + $${values.length + 2}, "updated_at" = clock_timestamp()
       WHERE ${predicate} AND "reserved_units" >= $${values.length + 1} RETURNING "reserved_units"`,
      [...values, reserved.toString(), charged.toString()]
    );
    if (result.length === 0) throw new Error('Credit counters did not contain the matching reservation.');
  }

  private async releaseReserved(runner: QueryRunner, table: 'credit_account_totals' | 'credit_account_daily_windows' | 'credit_demo_daily_windows' | 'credit_demo_campaign_usage', keys: Record<string, string | Date>, amount: bigint): Promise<void> {
    const { predicate, values } = whereKeys(keys);
    const result = await runner.query(
      `UPDATE "${table}" SET "reserved_units" = "reserved_units" - $${values.length + 1}, "updated_at" = clock_timestamp()
       WHERE ${predicate} AND "reserved_units" >= $${values.length + 1} RETURNING "reserved_units"`,
      [...values, amount.toString()]
    );
    if (result.length === 0) throw new Error('Credit counters did not contain the matching reservation.');
  }

  private async inTransaction<T>(action: (runner: QueryRunner) => Promise<T>): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      const result = await action(runner);
      await runner.commitTransaction();
      return result;
    } catch (error: unknown) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}

function enforceLimit(limit: string | null, counter: CounterRow, requested: bigint): void {
  if (limit === null) return;
  const current = BigInt(counter.settled_units) + BigInt(counter.reserved_units);
  if (current + requested > BigInt(limit)) throw denied('limit_exceeded');
}

function whereKeys(keys: Record<string, string | Date>): { predicate: string; values: readonly (string | Date)[] } {
  const columns = Object.keys(keys);
  const values = Object.values(keys);
  return { predicate: columns.map((column, index) => `"${column}" = $${index + 1}`).join(' AND '), values };
}

function toDate(value: Date | string | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('A persisted credit timestamp is invalid.');
  return parsed;
}

function safeUnknownReason(reason: string): string {
  return /^[a-z0-9_-]{1,64}$/u.test(reason) ? reason : 'provider_outcome_unknown';
}

function denied(reason: CreditDenialReason): ProviderCreditAdmissionDeniedError {
  return new ProviderCreditAdmissionDeniedError(reason);
}
