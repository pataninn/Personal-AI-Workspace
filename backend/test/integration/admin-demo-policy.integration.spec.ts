import { randomUUID } from 'node:crypto';
import { DataSource, type DataSourceOptions, type MigrationInterface, type QueryRunner } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmAdminPortalRepository } from '@/infrastructure/database/repositories/typeorm-admin-portal-repository';
import { TypeOrmDemoAdmissionRepository } from '@/infrastructure/database/repositories/typeorm-demo-admission-repository';
import { AdminDemoPolicy1710000037000 } from '@/infrastructure/database/migrations/1710000037000-admin-demo-policy';

const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
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

const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('admin demo policy PostgreSQL integration', () => {
  let dataSource: DataSource;
  let queryRunner: QueryRunner;
  let schema = '';

  beforeAll(async () => {
    const base = createDataSource({ url: databaseUrl ?? 'postgres://disabled:disabled@127.0.0.1:1/disabled' });
    await base.initialize();
    const baseRunner = base.createQueryRunner();
    await baseRunner.connect();
    schema = `admin_demo_${randomUUID().replace(/-/gu, '')}`;
    await baseRunner.query(`CREATE SCHEMA "${schema}"`);
    await baseRunner.release();
    await base.destroy();

    const scopedUrl = new URL(databaseUrl ?? 'postgres://disabled:disabled@127.0.0.1:1/disabled');
    scopedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    const sourceOptions = createDataSource({ url: scopedUrl.toString() }).options as DataSourceOptions;
    const configuredMigrations = sourceOptions.migrations as Array<new () => MigrationInterface>;
    const migrations = configuredMigrations.some((migration) => migration.name === 'AdminDemoPolicy1710000037000')
      ? configuredMigrations : [...configuredMigrations, AdminDemoPolicy1710000037000];
    dataSource = new DataSource({
      ...sourceOptions,
      migrations
    });
    await dataSource.initialize();
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    let adminPolicyMigration: MigrationInterface | undefined;
    for (const migration of dataSource.migrations) {
      if (migration.name === 'AdminDemoPolicy1710000037000') {
        adminPolicyMigration = migration;
        break;
      }
      await migration.up(queryRunner);
    }
    if (!adminPolicyMigration) throw new Error('Admin demo policy migration is absent from the test migration list.');
  }, 120_000);

  afterAll(async () => {
    if (queryRunner?.isReleased === false) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      if (schema) await queryRunner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await queryRunner.release();
    }
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('keeps issued demo semantics, bootstraps persisted policy once, applies limit CAS, and preserves counters', async () => {
    const adminId = randomUUID();
    await queryRunner.query(`
      INSERT INTO "users" ("id", "scope_key", "identifier", "account_kind", "role", "display_name", "password_hash")
      VALUES ($1, $2, 'task-3-6-admin', 'regular', 'admin', 'Admin fixture', 'fixture-hash')
    `, [adminId, `account:${randomUUID().replace(/-/gu, '')}`]);

    const legacyDemoId = randomUUID();
    await queryRunner.query(`
      INSERT INTO "users" ("id", "scope_key", "account_kind", "role", "display_name", "password_hash", "expires_at")
      VALUES ($1, $2, 'demo', 'user', 'Previously issued demo', NULL, now() + interval '1 day')
    `, [legacyDemoId, `demo:${randomUUID()}`]);
    await queryRunner.query('INSERT INTO "account_limits" ("owner_id") VALUES ($1)', [legacyDemoId]);

    const adminPolicyMigration = dataSource.migrations.find((migration) => migration.name === 'AdminDemoPolicy1710000037000');
    if (!adminPolicyMigration) throw new Error('Admin demo policy migration is absent from the test migration list.');
    await adminPolicyMigration.up(queryRunner);
    const legacyLimits: readonly { daily_credit_limit_units: string | null; lifetime_credit_limit_units: string | null;
      demo_credit_limits_configured: boolean }[] = await queryRunner.query(`
      SELECT "daily_credit_limit_units"::text, "lifetime_credit_limit_units"::text, "demo_credit_limits_configured"
      FROM "account_limits" WHERE "owner_id" = $1
    `, [legacyDemoId]);
    expect(legacyLimits).toEqual([{ daily_credit_limit_units: null, lifetime_credit_limit_units: null, demo_credit_limits_configured: true }]);

    const demoAdmission = new TypeOrmDemoAdmissionRepository(dataSource);
    const bootstrap = {
      lifetimeHours: 24,
      limits: { globalAdmissionMax: 80, globalAdmissionWindowSeconds: 3600, networkAdmissionMax: 20,
        networkAdmissionWindowSeconds: 900, runStartMax: 30, runStartWindowSeconds: 3600 }
    } as const;
    await demoAdmission.bootstrapSettings(bootstrap);
    await demoAdmission.bootstrapSettings({ ...bootstrap, lifetimeHours: 12 });
    const persisted: readonly { demo_settings_bootstrapped: boolean; demo_session_ttl_hours: number | null;
      demo_global_admission_max: number | null }[] = await queryRunner.query(`
      SELECT "demo_settings_bootstrapped", "demo_session_ttl_hours", "demo_global_admission_max"
      FROM "credit_runtime_policy" WHERE "id" = 1
    `);
    expect(persisted).toEqual([{ demo_settings_bootstrapped: true, demo_session_ttl_hours: 24, demo_global_admission_max: 80 }]);

    const portal = new TypeOrmAdminPortalRepository(dataSource);
    const created = await portal.createAccount(adminId, {
      displayName: 'Zero quota member', identifier: 'quota-member', passwordHash: 'only-a-hash'
    }) as { account: { id: string; identifier: string } };
    expect(created.account).toMatchObject({ identifier: 'quota-member' });
    expect(JSON.stringify(created)).not.toContain('only-a-hash');
    await portal.updateAccountLimits(adminId, created.account.id, {
      expectedRevision: 1, dailyCreditLimitUnits: '0', lifetimeCreditLimitUnits: null, storageLimitBytes: null
    });
    await expect(portal.updateAccountLimits(adminId, created.account.id, {
      expectedRevision: 1, dailyCreditLimitUnits: null, lifetimeCreditLimitUnits: null, storageLimitBytes: null
    })).rejects.toMatchObject({ code: 'ADMIN_REVISION_CONFLICT', statusCode: 409 });
    const regularUsage = await portal.readCreditUsage(created.account.id) as {
      daily: { limitUnits: string | null; remainingUnits: string | null };
      lifetime: { limitUnits: string | null; remainingUnits: string | null };
      availability: { status: string; canSubmit: boolean };
    };
    expect(regularUsage).toMatchObject({ daily: { limitUnits: '0', remainingUnits: '0' },
      lifetime: { limitUnits: null, remainingUnits: null }, availability: { status: 'paused', canSubmit: false } });

    const newDemoId = randomUUID();
    await queryRunner.query(`
      INSERT INTO "users" ("id", "scope_key", "account_kind", "role", "display_name", "password_hash", "expires_at")
      VALUES ($1, $2, 'demo', 'user', 'New demo fixture', NULL, now() + interval '1 day')
    `, [newDemoId, `demo:${randomUUID()}`]);
    await queryRunner.query('INSERT INTO "account_limits" ("owner_id") VALUES ($1)', [newDemoId]);
    await queryRunner.query('INSERT INTO "credit_account_totals" ("owner_id") VALUES ($1)', [newDemoId]);
    const currentDailyWindow: readonly { window_start: Date }[] = await queryRunner.query(`
      INSERT INTO "credit_demo_daily_windows" ("window_start", "window_end", "settled_units", "reserved_units")
      SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
        (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC', 17, 9
      RETURNING "window_start"
    `);
    await queryRunner.query('INSERT INTO "credit_demo_campaign_usage" ("campaign_id", "settled_units", "reserved_units") VALUES ($1, 12, 4)', ['campaign-3-6']);
    const settings = await portal.updateDemoSettings(adminId, {
      expectedRevision: 1,
      defaultDailyLimitUnits: '1000', defaultLifetimeLimitUnits: '5000', sessionTtlHours: 24,
      globalAdmissionMax: 80, globalAdmissionWindowSeconds: 3600, networkAdmissionMax: 20, networkAdmissionWindowSeconds: 900,
      runStartMax: 30, runStartWindowSeconds: 3600, maxConcurrentCalls: 2,
      globalDailyLimitUnits: '100', campaignId: 'campaign-3-6', campaignLimitUnits: '100', inferencePaused: false
    }) as { revision: number; usage: { dailySettledUnits: string; dailyReservedUnits: string;
      campaignSettledUnits: string; campaignReservedUnits: string } };
    expect(settings).toMatchObject({ revision: 2, usage: {
      dailySettledUnits: '17', dailyReservedUnits: '9', campaignSettledUnits: '12', campaignReservedUnits: '4'
    } });
    expect(currentDailyWindow[0]?.window_start).toBeInstanceOf(Date);
    const unconfiguredDemo = await portal.readCreditUsage(newDemoId) as { availability: { status: string; canSubmit: boolean } };
    expect(unconfiguredDemo.availability).toEqual({ status: 'unknown', reason: 'Demo credit allowances are not configured.', canSubmit: false });

    const newDemoLimits: readonly { demo_credit_limits_configured: boolean }[] = await queryRunner.query(
      'SELECT "demo_credit_limits_configured" FROM "account_limits" WHERE "owner_id" = $1', [newDemoId]
    );
    expect(newDemoLimits[0]?.demo_credit_limits_configured).toBe(false);
    await portal.updateAccountLimits(adminId, newDemoId, {
      expectedRevision: 1, dailyCreditLimitUnits: '0', lifetimeCreditLimitUnits: null, storageLimitBytes: null
    });
    const configuredDemo: readonly { demo_credit_limits_configured: boolean }[] = await queryRunner.query(
      'SELECT "demo_credit_limits_configured" FROM "account_limits" WHERE "owner_id" = $1', [newDemoId]
    );
    expect(configuredDemo[0]?.demo_credit_limits_configured).toBe(true);
    const settledCounters: readonly { settled_units: string; reserved_units: string }[] = await queryRunner.query(`
      SELECT "settled_units"::text, "reserved_units"::text FROM "credit_demo_daily_windows" WHERE "window_start" = $1
    `, [currentDailyWindow[0]?.window_start]);
    expect(settledCounters).toEqual([{ settled_units: '17', reserved_units: '9' }]);
    const campaignCounters: readonly { settled_units: string; reserved_units: string }[] = await queryRunner.query(
      'SELECT "settled_units"::text, "reserved_units"::text FROM "credit_demo_campaign_usage" WHERE "campaign_id" = $1', ['campaign-3-6']
    );
    expect(campaignCounters).toEqual([{ settled_units: '12', reserved_units: '4' }]);
  }, 30_000);
});
