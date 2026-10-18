import type { DataSource } from 'typeorm';
import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmCreditLedgerRepository } from '@/infrastructure/database/repositories/typeorm-credit-ledger-repository';
import type { CreditReservationCommand } from '@/modules/credits/repositories/credit-ledger-repository';
import { ProviderCreditAdmissionDeniedError } from '@/modules/credits/domain/credit-errors';
import { creditDailyWindowAt } from '@/modules/credits/domain/credit-time-windows';
import { maximumCreditUnits, POSTGRES_BIGINT_MAX } from '@/modules/credits/domain/credit-calculation';

const DATABASE_NAME = 'home_history_task_3_1_credit_test';
const REGULAR_ID = '3a310000-0000-4000-8000-000000000001';
const DEMO_ID = '3a310000-0000-4000-8000-000000000002';
const DEMO_ID_TWO = '3a310000-0000-4000-8000-000000000003';
const OVERFLOW_ID = '3a310000-0000-4000-8000-000000000004';
const SOURCE_ONE = '3a311000-0000-4000-8000-000000000001';
const SOURCE_TWO = '3a311000-0000-4000-8000-000000000002';
const SOURCE_THREE = '3a311000-0000-4000-8000-000000000003';
const SOURCE_FOUR = '3a311000-0000-4000-8000-000000000004';
const SOURCE_FIVE = '3a311000-0000-4000-8000-000000000005';
const SOURCE_SIX = '3a311000-0000-4000-8000-000000000006';
const SOURCE_SEVEN = '3a311000-0000-4000-8000-000000000007';
const SOURCE_EIGHT = '3a311000-0000-4000-8000-000000000008';
const SOURCE_NINE = '3a311000-0000-4000-8000-000000000009';
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

interface PgClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
}

const { Client } = require('pg') as { readonly Client: new (options: { readonly connectionString: string }) => PgClient };

if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !new Set(['127.0.0.1', 'localhost', '::1', '[::1]']).has(target.hostname)
    || target.port !== '55441'
    || target.pathname !== '/home_history_test'
    || target.username !== 'home_test') {
    throw new Error('HOME_CONVERSATION_TEST_DATABASE_URL must target home_test/home_history_test on loopback port 55441.');
  }
}

describeDatabase('Task 3.1 PostgreSQL credit ledger', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let repository: TypeOrmCreditLedgerRepository;
  let targetUrl: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded credit-ledger integration database URL is required.');
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string;
        readonly user: string;
        readonly canCreateDatabase: boolean;
        readonly databaseExists: boolean;
      }>(`
        SELECT current_database() AS "database", current_user AS "user",
          (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname" = current_user) AS "canCreateDatabase",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "databaseExists"
      `, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test'
        || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.canCreateDatabase !== true) {
        throw new Error('The guarded Task 3.1 test role cannot create its isolated database.');
      }
      if (identity.rows[0]?.databaseExists) {
        throw new Error('The fixed Task 3.1 database already exists; inspect ownership before retrying.');
      }
      await baseClient.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "home_test"`);
      databaseCreated = true;
    } finally {
      await baseClient.end();
    }

    const target = new URL(databaseUrl);
    target.pathname = `/${DATABASE_NAME}`;
    targetUrl = target.toString();
    dataSource = createDataSource({ url: targetUrl });
    await dataSource.initialize();
    const identity: readonly { readonly database: string; readonly user: string }[] = await dataSource.query(
      'SELECT current_database() AS "database", current_user AS "user"'
    );
    expect(identity).toEqual([{ database: DATABASE_NAME, user: 'home_test' }]);
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    expect(applied).toHaveLength(dataSource.migrations.length);
    repository = new TypeOrmCreditLedgerRepository(dataSource);

    await dataSource.query(`
      INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash", "identifier", "account_kind", "role", "expires_at")
      VALUES
        ($1, 'account:credit-regular', 'Credit regular', 'fixture-hash', 'credit-regular', 'regular', 'user', NULL),
        ($2, 'account:credit-demo', 'Credit demo', NULL, NULL, 'demo', 'user', clock_timestamp() + interval '1 day'),
        ($3, 'account:credit-demo-two', 'Credit demo two', NULL, NULL, 'demo', 'user', clock_timestamp() + interval '1 day')
    `, [REGULAR_ID, DEMO_ID, DEMO_ID_TWO]);
    await dataSource.query(`
      INSERT INTO "account_limits" ("owner_id", "max_concurrent_inference_calls")
      VALUES ($1, 2)
      ON CONFLICT ("owner_id") DO UPDATE SET "max_concurrent_inference_calls" = EXCLUDED."max_concurrent_inference_calls"
    `, [REGULAR_ID]);
    await dataSource.query(`
      UPDATE "credit_runtime_policy" SET "inference_paused" = false,
        "demo_daily_limit_units" = 20, "demo_campaign_limit_units" = 30,
        "demo_campaign_id" = 'credit-fixture', "demo_max_concurrent_calls" = 2 WHERE "id" = 1
    `);
    await dataSource.query('UPDATE "account_limits" SET "max_concurrent_inference_calls" = 2 WHERE "owner_id" = $1', [REGULAR_ID]);
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (!databaseCreated || !databaseUrl) return;
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string;
        readonly user: string;
        readonly owner: string | null;
        readonly exists: boolean;
      }>(`
        SELECT current_database() AS "database", current_user AS "user",
          (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname" = $1) AS "owner",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "exists"
      `, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.owner !== 'home_test') {
        throw new Error('Refusing to remove the Task 3.1 test database because its guarded identity changed.');
      }
      if (!identity.rows[0]?.exists) {
        databaseCreated = false;
        return;
      }
      await baseClient.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [DATABASE_NAME]
      );
      await baseClient.query(`DROP DATABASE "${DATABASE_NAME}"`);
      databaseCreated = false;
    } finally {
      await baseClient.end();
    }
  });

  it('serializes concurrent reservations against daily and lifetime limits', async () => {
    await dataSource!.query(
      'UPDATE "account_limits" SET "daily_credit_limit_units" = 10, "lifetime_credit_limit_units" = 10 WHERE "owner_id" = $1',
      [REGULAR_ID]
    );
    const results = await Promise.allSettled([
      repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_ONE, 'call-a', '1')),
      repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_TWO, 'call-b', '1'))
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ProviderCreditAdmissionDeniedError);
    expect(rejected?.reason).toMatchObject({ reason: 'limit_exceeded' });
    const totals: readonly { settled_units: string; reserved_units: string }[] = await dataSource!.query(
      'SELECT "settled_units", "reserved_units" FROM "credit_account_totals" WHERE "owner_id" = $1', [REGULAR_ID]
    );
    expect(totals).toEqual([{ settled_units: '0', reserved_units: '7' }]);
    const accepted = results.find((result): result is PromiseFulfilledResult<{ reservationId: string; maximumUnits: bigint }> => result.status === 'fulfilled');
    expect(accepted).toBeDefined();
    await repository.releaseKnownNotSent(accepted!.value.reservationId);
    await dataSource!.query('UPDATE "account_limits" SET "daily_credit_limit_units" = 0, "lifetime_credit_limit_units" = NULL WHERE "owner_id" = $1', [REGULAR_ID]);
    await expect(repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_ONE, 'zero-daily', '1')))
      .rejects.toMatchObject({ reason: 'limit_exceeded' });
    await dataSource!.query('UPDATE "account_limits" SET "daily_credit_limit_units" = NULL, "lifetime_credit_limit_units" = 0 WHERE "owner_id" = $1', [REGULAR_ID]);
    await expect(repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_ONE, 'zero-lifetime', '1')))
      .rejects.toMatchObject({ reason: 'limit_exceeded' });
    await dataSource!.query('UPDATE "account_limits" SET "lifetime_credit_limit_units" = NULL WHERE "owner_id" = $1', [REGULAR_ID]);
  });

  it('settles once, retains unknown amounts, and releases only proven-not-sent reservations', async () => {
    await dataSource!.query(
      'UPDATE "account_limits" SET "daily_credit_limit_units" = NULL, "lifetime_credit_limit_units" = NULL WHERE "owner_id" = $1',
      [REGULAR_ID]
    );
    const settled = await repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_THREE, 'settle', '1'));
    await expect(repository.settleProviderCall({ reservationId: settled.reservationId, usage: { promptTokens: 1, completionTokens: 1 } }))
      .resolves.toMatchObject({ outcome: 'settled', chargedUnits: 2n });
    await expect(repository.settleProviderCall({ reservationId: settled.reservationId, usage: { promptTokens: 1, completionTokens: 1 } }))
      .resolves.toMatchObject({ outcome: 'replayed', chargedUnits: 2n });

    const unknown = await repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_FOUR, 'unknown', '1'));
    await repository.retainUnknown(unknown.reservationId, 'network_lost');
    const unknownRows: readonly { status: string; reserved_units: string }[] = await dataSource!.query(
      'SELECT r."status", t."reserved_units" FROM "credit_provider_call_reservations" r JOIN "credit_account_totals" t ON t."owner_id" = r."owner_id" WHERE r."id" = $1',
      [unknown.reservationId]
    );
    expect(unknownRows).toEqual([{ status: 'unknown', reserved_units: '7' }]);
    await expect(repository.releaseKnownNotSent(unknown.reservationId)).rejects.toThrow('known not to have been sent');

    const notSent = await repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_FIVE, 'not-sent', '1'));
    await repository.releaseKnownNotSent(notSent.reservationId);
    const released: readonly { status: string; reserved_units: string }[] = await dataSource!.query(
      'SELECT r."status", t."reserved_units" FROM "credit_provider_call_reservations" r JOIN "credit_account_totals" t ON t."owner_id" = r."owner_id" WHERE r."id" = $1',
      [notSent.reservationId]
    );
    expect(released[0]).toMatchObject({ status: 'released', reserved_units: '7' });

    const inconsistent = await repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_FIVE, 'bad-total', '2'));
    await expect(repository.settleProviderCall({
      reservationId: inconsistent.reservationId,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 5 }
    })).rejects.toThrow('Provider usage totals are inconsistent.');
    const rejectedUsage: readonly { status: string; usage_count: string }[] = await dataSource!.query(`
      SELECT r."status", count(u."reservation_id")::text AS "usage_count"
      FROM "credit_provider_call_reservations" r
      LEFT JOIN "credit_usage_entries" u ON u."reservation_id" = r."id"
      WHERE r."id" = $1 GROUP BY r."status"
    `, [inconsistent.reservationId]);
    expect(rejectedUsage).toEqual([{ status: 'in_flight', usage_count: '0' }]);
    await repository.releaseKnownNotSent(inconsistent.reservationId);
  });

  it('enforces demo UTC daily and campaign reservations independently', async () => {
    const beforeLazyCreate: readonly { count: number }[] = await dataSource!.query(
      'SELECT count(*)::integer AS "count" FROM "account_limits" WHERE "owner_id" = $1', [DEMO_ID]
    );
    expect(beforeLazyCreate).toEqual([{ count: 0 }]);
    await dataSource!.query('UPDATE "account_limits" SET "daily_credit_limit_units" = NULL WHERE "owner_id" = $1', [DEMO_ID]);
    await dataSource!.query('UPDATE "account_limits" SET "max_concurrent_inference_calls" = 1 WHERE "owner_id" = $1', [DEMO_ID]);
    await dataSource!.query('UPDATE "credit_runtime_policy" SET "demo_max_concurrent_calls" = 1 WHERE "id" = 1');
    const singleSlot = await repository.reserveProviderCall(reservation(DEMO_ID, SOURCE_EIGHT, 'demo-single-slot', '1'));
    const lazyDefaults: readonly { max_concurrent_inference_calls: number; credit_timezone: string; daily_credit_limit_units: string | null; lifetime_credit_limit_units: string | null }[] = await dataSource!.query(
      'SELECT "max_concurrent_inference_calls", "credit_timezone", "daily_credit_limit_units", "lifetime_credit_limit_units" FROM "account_limits" WHERE "owner_id" = $1', [DEMO_ID]
    );
    expect(lazyDefaults).toEqual([{ max_concurrent_inference_calls: 1, credit_timezone: 'Asia/Shanghai', daily_credit_limit_units: null, lifetime_credit_limit_units: null }]);
    await expect(repository.reserveProviderCall(reservation(DEMO_ID, SOURCE_SEVEN, 'demo-second-slot-denied', '1')))
      .rejects.toMatchObject({ reason: 'call_limit_exceeded' });
    await repository.releaseKnownNotSent(singleSlot.reservationId);

    await dataSource!.query('UPDATE "account_limits" SET "max_concurrent_inference_calls" = 4 WHERE "owner_id" = $1', [DEMO_ID]);
    await dataSource!.query('UPDATE "credit_runtime_policy" SET "demo_max_concurrent_calls" = 4 WHERE "id" = 1');

    await dataSource!.query('UPDATE "credit_runtime_policy" SET "demo_daily_limit_units" = 10, "demo_campaign_limit_units" = 30 WHERE "id" = 1');
    const demoDailyRace = await Promise.allSettled([
      repository.reserveProviderCall(reservation(DEMO_ID, SOURCE_SIX, 'demo-daily-race-a', '1')),
      repository.reserveProviderCall(reservation(DEMO_ID_TWO, SOURCE_SEVEN, 'demo-daily-race-b', '1'))
    ]);
    expect(demoDailyRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const deniedDailyRace = demoDailyRace.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(deniedDailyRace?.reason).toMatchObject({ reason: 'limit_exceeded' });
    const demoDailyUsage: readonly { settled_units: string; reserved_units: string }[] = await dataSource!.query(
      'SELECT sum("settled_units")::text AS "settled_units", sum("reserved_units")::text AS "reserved_units" FROM "credit_demo_daily_windows"'
    );
    expect(demoDailyUsage).toEqual([{ settled_units: '0', reserved_units: '7' }]);
    const acceptedDailyRace = demoDailyRace.find((result) => result.status === 'fulfilled');
    expect(acceptedDailyRace?.status).toBe('fulfilled');
    if (!acceptedDailyRace || acceptedDailyRace.status !== 'fulfilled') throw new Error('The demo daily race admitted no call.');
    await repository.releaseKnownNotSent(acceptedDailyRace.value.reservationId);

    await dataSource!.query('UPDATE "credit_runtime_policy" SET "demo_daily_limit_units" = 20, "demo_campaign_limit_units" = 10 WHERE "id" = 1');
    const campaignRace = await Promise.allSettled([
      repository.reserveProviderCall(reservation(DEMO_ID, SOURCE_SIX, 'demo-campaign-race-a', '2')),
      repository.reserveProviderCall(reservation(DEMO_ID_TWO, SOURCE_SEVEN, 'demo-campaign-race-b', '2'))
    ]);
    expect(campaignRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const deniedCampaignRace = campaignRace.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(deniedCampaignRace?.reason).toMatchObject({ reason: 'limit_exceeded' });
    const campaignUsage: readonly { settled_units: string; reserved_units: string }[] = await dataSource!.query(
      'SELECT "settled_units", "reserved_units" FROM "credit_demo_campaign_usage" WHERE "campaign_id" = $1', ['credit-fixture']
    );
    expect(campaignUsage).toEqual([{ settled_units: '0', reserved_units: '7' }]);
    const acceptedCampaignRace = campaignRace.find((result) => result.status === 'fulfilled');
    expect(acceptedCampaignRace?.status).toBe('fulfilled');
    if (!acceptedCampaignRace || acceptedCampaignRace.status !== 'fulfilled') throw new Error('The demo campaign race admitted no call.');
    await repository.releaseKnownNotSent(acceptedCampaignRace.value.reservationId);
    await dataSource!.query('UPDATE "credit_runtime_policy" SET "demo_campaign_limit_units" = 30 WHERE "id" = 1');

    const first = await repository.reserveProviderCall(reservation(DEMO_ID, SOURCE_ONE, 'demo-a', '1'));
    const second = await repository.reserveProviderCall(reservation(DEMO_ID, SOURCE_TWO, 'demo-b', '1'));
    await expect(repository.reserveProviderCall(reservation(DEMO_ID, SOURCE_THREE, 'demo-daily', '1')))
      .rejects.toMatchObject({ reason: 'limit_exceeded' });
    await repository.releaseKnownNotSent(first.reservationId);
    await repository.releaseKnownNotSent(second.reservationId);

    await dataSource!.query('UPDATE "credit_runtime_policy" SET "demo_daily_limit_units" = 0 WHERE "id" = 1');
    await expect(repository.reserveProviderCall(reservation(DEMO_ID, SOURCE_THREE, 'demo-zero', '1')))
      .rejects.toMatchObject({ reason: 'limit_exceeded' });
    await dataSource!.query('UPDATE "credit_runtime_policy" SET "demo_daily_limit_units" = 20, "demo_campaign_limit_units" = 0 WHERE "id" = 1');
    await expect(repository.reserveProviderCall(reservation(DEMO_ID, SOURCE_FOUR, 'campaign-zero', '1')))
      .rejects.toMatchObject({ reason: 'limit_exceeded' });
  });

  it('denies paused, disabled, and expired accounts before reserving', async () => {
    await dataSource!.query('UPDATE "credit_runtime_policy" SET "inference_paused" = true WHERE "id" = 1');
    await expect(repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_ONE, 'paused', '1')))
      .rejects.toMatchObject({ reason: 'paused' });
    await dataSource!.query('UPDATE "credit_runtime_policy" SET "inference_paused" = false WHERE "id" = 1');
    await dataSource!.query('UPDATE "users" SET "is_active" = false WHERE "id" = $1', [REGULAR_ID]);
    await expect(repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_ONE, 'disabled', '1')))
      .rejects.toMatchObject({ reason: 'account_inactive' });
    await dataSource!.query('UPDATE "users" SET "is_active" = true WHERE "id" = $1', [REGULAR_ID]);
    await dataSource!.query('UPDATE "users" SET "expires_at" = clock_timestamp() - interval \'1 second\' WHERE "id" = $1', [DEMO_ID]);
    await expect(repository.reserveProviderCall(reservation(DEMO_ID, SOURCE_ONE, 'expired', '1')))
      .rejects.toMatchObject({ reason: 'account_inactive' });
  });

  it('applies a timezone at the old local midnight and settles earlier calls into their captured window', async () => {
    const oldZone = 'America/New_York';
    const newZone = 'Asia/Tokyo';
    await dataSource!.query(`
      UPDATE "account_limits" SET "daily_credit_limit_units" = NULL, "lifetime_credit_limit_units" = NULL,
        "credit_timezone" = $2, "pending_credit_timezone" = NULL, "timezone_effective_at" = NULL,
        "timezone_started_at" = NULL, "max_concurrent_inference_calls" = 4 WHERE "owner_id" = $1
    `, [REGULAR_ID, oldZone]);
    const beforeChange = await repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_SIX, 'before-zone-change', '1'));
    const oldRows: readonly { account_window_start: Date; timezone_name: string }[] = await dataSource!.query(
      `SELECT r."account_window_start", w."timezone_name" FROM "credit_provider_call_reservations" r
       JOIN "credit_account_daily_windows" w ON w."owner_id" = r."owner_id" AND w."window_start" = r."account_window_start"
       WHERE r."id" = $1`, [beforeChange.reservationId]
    );
    expect(oldRows[0]?.timezone_name).toBe(oldZone);

    const returnedBoundary = await repository.queueAccountTimeZoneChange({ ownerId: REGULAR_ID, timeZone: newZone });
    expect(creditDailyWindowAt(returnedBoundary, oldZone).startsAt.toISOString()).toBe(returnedBoundary.toISOString());
    const queued: readonly { pending_credit_timezone: string; timezone_effective_at: Date }[] = await dataSource!.query(
      'SELECT "pending_credit_timezone", "timezone_effective_at" FROM "account_limits" WHERE "owner_id" = $1', [REGULAR_ID]
    );
    expect(queued[0]).toMatchObject({ pending_credit_timezone: newZone });
    expect(new Date(queued[0]!.timezone_effective_at).toISOString()).toBe(returnedBoundary.toISOString());

    // Move only the test fixture's pending boundary into the past to exercise activation without waiting for midnight.
    const simulatedBoundary: readonly { boundary: Date }[] = await dataSource!.query(
      'SELECT clock_timestamp() - interval \'1 second\' AS "boundary"'
    );
    await dataSource!.query(
      'UPDATE "account_limits" SET "timezone_effective_at" = $2 WHERE "owner_id" = $1', [REGULAR_ID, simulatedBoundary[0]!.boundary]
    );
    const afterChange = await repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_SEVEN, 'after-zone-change', '1'));
    const newRows: readonly { account_window_start: Date; timezone_name: string }[] = await dataSource!.query(
      `SELECT r."account_window_start", w."timezone_name" FROM "credit_provider_call_reservations" r
       JOIN "credit_account_daily_windows" w ON w."owner_id" = r."owner_id" AND w."window_start" = r."account_window_start"
       WHERE r."id" = $1`, [afterChange.reservationId]
    );
    expect(newRows[0]?.timezone_name).toBe(newZone);
    expect(new Date(newRows[0]!.account_window_start).toISOString()).toBe(new Date(simulatedBoundary[0]!.boundary).toISOString());

    await repository.settleProviderCall({ reservationId: beforeChange.reservationId, usage: { promptTokens: 1, completionTokens: 1 } });
    const capturedWindow: readonly { settled_units: string; reserved_units: string; timezone_name: string }[] = await dataSource!.query(
      `SELECT "settled_units", "reserved_units", "timezone_name" FROM "credit_account_daily_windows"
       WHERE "owner_id" = $1 AND "window_start" = $2`, [REGULAR_ID, oldRows[0]!.account_window_start]
    );
    expect(capturedWindow).toEqual([{ settled_units: '2', reserved_units: '0', timezone_name: oldZone }]);
    await repository.releaseKnownNotSent(afterChange.reservationId);
  });

  it('charges validated over-bound usage and pauses subsequent provider admissions', async () => {
    await dataSource!.query('UPDATE "credit_runtime_policy" SET "inference_paused" = false WHERE "id" = 1');
    const held = await repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_EIGHT, 'over-bound', '1'));

    await expect(repository.settleProviderCall({
      reservationId: held.reservationId,
      usage: { promptTokens: 5, completionTokens: 4 }
    })).resolves.toEqual({ outcome: 'over_bound', chargedUnits: 9n });
    const state: readonly { status: string; charged_units: string; inference_paused: boolean }[] = await dataSource!.query(`
      SELECT r."status", r."charged_units", p."inference_paused"
      FROM "credit_provider_call_reservations" r CROSS JOIN "credit_runtime_policy" p WHERE r."id" = $1 AND p."id" = 1
    `, [held.reservationId]);
    expect(state).toEqual([{ status: 'over_bound', charged_units: '9', inference_paused: true }]);
    await expect(repository.reserveProviderCall(reservation(REGULAR_ID, SOURCE_ONE, 'after-over-bound', '1')))
      .rejects.toMatchObject({ reason: 'paused' });
  });

  it('pauses inference and retains an unknown reservation when a reported charge exceeds bigint', async () => {
    await dataSource!.query('UPDATE "credit_runtime_policy" SET "inference_paused" = false WHERE "id" = 1');
    await dataSource!.query(`
      INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash", "identifier", "account_kind", "role", "expires_at")
      VALUES ($1, 'account:credit-overflow', 'Credit overflow', 'fixture-hash', 'credit-overflow', 'regular', 'user', NULL)
    `, [OVERFLOW_ID]);
    const price = {
      version: 'overflow-fixture-v1',
      inputUnitsPerMillionTokens: POSTGRES_BIGINT_MAX,
      outputUnitsPerMillionTokens: POSTGRES_BIGINT_MAX
    };
    const maximumUnits = maximumCreditUnits(
      { inputTokens: 4, outputTokens: 3 },
      { inputUnitsPerMillionTokens: price.inputUnitsPerMillionTokens, outputUnitsPerMillionTokens: price.outputUnitsPerMillionTokens }
    );
    const held = await repository.reserveProviderCall({
      ...reservation(OVERFLOW_ID, SOURCE_NINE, 'overflow-charge', '1'),
      price,
      maximumUnits
    });

    await expect(repository.settleProviderCall({
      reservationId: held.reservationId,
      usage: { promptTokens: Number.MAX_SAFE_INTEGER - 2, completionTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER - 1 }
    })).resolves.toEqual({ outcome: 'unknown', reason: 'usage_charge_overflow' });
    const state: readonly { status: string; unknown_reason: string; charged_units: string | null; actual_input_tokens: string; reserved_units: string; inference_paused: boolean; usage_count: string }[] = await dataSource!.query(`
      SELECT r."status", r."unknown_reason", r."charged_units", r."actual_input_tokens", t."reserved_units",
             p."inference_paused", count(u."reservation_id")::text AS "usage_count"
      FROM "credit_provider_call_reservations" r
      JOIN "credit_account_totals" t ON t."owner_id" = r."owner_id"
      CROSS JOIN "credit_runtime_policy" p
      LEFT JOIN "credit_usage_entries" u ON u."reservation_id" = r."id"
      WHERE r."id" = $1 AND p."id" = 1
      GROUP BY r."id", t."owner_id", p."id"
    `, [held.reservationId]);
    expect(state).toEqual([{
      status: 'unknown', unknown_reason: 'usage_charge_overflow', charged_units: null,
      actual_input_tokens: String(Number.MAX_SAFE_INTEGER - 2), reserved_units: maximumUnits.toString(),
      inference_paused: true, usage_count: '0'
    }]);
    await expect(repository.reserveProviderCall(reservation(OVERFLOW_ID, SOURCE_ONE, 'after-overflow', '1')))
      .rejects.toMatchObject({ reason: 'paused' });
  });
});

function reservation(ownerId: string, sourceId: string, callId: string, attemptId: string): CreditReservationCommand {
  return {
    ownerId,
    sourceKind: 'ai_run',
    sourceId,
    callId,
    attemptId,
    providerProfile: 'nvidia-hosted-nim',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    price: { version: 'offline-fixture-v1', inputUnitsPerMillionTokens: 1_000_000n, outputUnitsPerMillionTokens: 1_000_000n },
    inputBounderVersion: 'fixture-bound-v1',
    maxInputTokens: 4,
    maxOutputTokens: 3,
    maxAttemptsForSource: 1,
    maximumUnits: 7n
  };
}
