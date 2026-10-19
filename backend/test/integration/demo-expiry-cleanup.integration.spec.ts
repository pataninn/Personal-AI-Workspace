import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmDemoAdmissionRepository } from '@/infrastructure/database/repositories/typeorm-demo-admission-repository';
import { TypeOrmDemoExpiryCleanupRepository } from '@/infrastructure/database/repositories/typeorm-demo-expiry-cleanup-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import { TypeOrmCreditLedgerRepository } from '@/infrastructure/database/repositories/typeorm-credit-ledger-repository';
import { WorkspaceBoundaryAdapter, type WorkspaceFileSystem } from '@/infrastructure/workspace/workspace-boundary';
import { ProjectRecoveryCleaner } from '@/infrastructure/workspace/project-recovery-cleaner';
import { digestIdempotencyKey, CreateDemoSessionUseCase } from '@/modules/demo/use-cases/create-demo-session';
import type { DemoExpiryCancellationPort } from '@/modules/demo/domain/demo-expiry-cleanup-types';
import type { CreditReservationCommand } from '@/modules/credits/repositories/credit-ledger-repository';

const DATABASE_NAME = 'home_history_task_3_5_demo_expiry_test';
const DEMO_OWNER_ID = 'd3550000-0000-4000-8000-000000000101';
const REGULAR_OWNER_ID = 'd3550000-0000-4000-8000-000000000102';
const ADMIN_OWNER_ID = 'd3550000-0000-4000-8000-000000000103';
const DEMO_ADMISSION_ID = 'd3550000-0000-4000-8000-000000000201';
const COPY_PROJECT_ID = 'd3550000-0000-4000-8000-000000000301';
const REGULAR_PROJECT_ID = 'd3550000-0000-4000-8000-000000000302';
const SHOWCASE_VERSION_ID = 'd3550000-0000-4000-8000-000000000401';
const CREDIT_SOURCE_ONE = 'd3550000-0000-4000-8000-000000000501';
const CREDIT_SOURCE_TWO = 'd3550000-0000-4000-8000-000000000502';
const CREDIT_CAMPAIGN_ID = 'task-3-5-credit-retention-fixture';
const IDEMPOTENCY_KEY = Buffer.alloc(32, 0x35).toString('base64url');
const REQUEST_DIGEST = digestIdempotencyKey(IDEMPOTENCY_KEY);
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
    || target.port !== '55441' || target.pathname !== '/home_history_test' || target.username !== 'home_test') {
    throw new Error('HOME_CONVERSATION_TEST_DATABASE_URL must target home_test/home_history_test on loopback port 55441.');
  }
}

class VirtualWorkspaceFileSystem implements WorkspaceFileSystem {
  public constructor(private readonly legacyRoot: string, private readonly managedRoot: string) {}

  public async lstat(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
    return await fs.lstat(this.physical(filePath));
  }

  public async mkdir(filePath: string): Promise<void> { await fs.mkdir(this.physical(filePath)); }
  public async readFile(filePath: string): Promise<string> { return await fs.readFile(this.physical(filePath), 'utf8'); }
  public async readdir(directoryPath: string): Promise<readonly string[]> { return await fs.readdir(this.physical(directoryPath)); }
  public async unlink(filePath: string): Promise<void> { await fs.unlink(this.physical(filePath)); }
  public async rmdir(directoryPath: string): Promise<void> { await fs.rmdir(this.physical(directoryPath)); }

  public async realpath(filePath: string): Promise<string> {
    const physical = this.physical(filePath);
    const canonical = await fs.realpath(physical);
    if (path.resolve(canonical).toLocaleLowerCase('en-US') === path.resolve(physical).toLocaleLowerCase('en-US')) return filePath;
    return canonical;
  }

  private physical(filePath: string): string {
    if (filePath === '/workspace' || filePath.startsWith('/workspace/')) {
      return path.join(this.legacyRoot, ...filePath.slice('/workspace'.length).split('/').filter(Boolean));
    }
    if (filePath === '/account-workspaces' || filePath.startsWith('/account-workspaces/')) {
      return path.join(this.managedRoot, ...filePath.slice('/account-workspaces'.length).split('/').filter(Boolean));
    }
    throw new Error('The integration boundary received a path outside its virtual roots.');
  }
}

describeDatabase('Task 3.5 demo expiry cleanup with PostgreSQL and managed storage', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let targetUrl: string;
  let workspaceRoot: string | undefined;
  let workspace: WorkspaceBoundaryAdapter;
  let cancellation: DemoExpiryCancellationPort;
  let quota: TypeOrmStorageQuotaRepository;
  let roots: TypeOrmStorageRootMappingRepository;
  let recovery: ProjectRecoveryCleaner;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded demo expiry database URL is required.');
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string; readonly user: string; readonly canCreateDatabase: boolean; readonly databaseExists: boolean;
      }>(`SELECT current_database() AS "database", current_user AS "user",
        (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname"=current_user) AS "canCreateDatabase",
        EXISTS (SELECT 1 FROM "pg_database" WHERE "datname"=$1) AS "databaseExists"`, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.canCreateDatabase !== true || identity.rows[0]?.databaseExists) {
        throw new Error('The guarded demo expiry role cannot safely create its isolated database.');
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
    const connectedIdentity: readonly { readonly database: string; readonly user: string }[] = await dataSource.query(
      'SELECT current_database() AS "database", current_user AS "user"'
    );
    expect(connectedIdentity).toEqual([{ database: DATABASE_NAME, user: 'home_test' }]);
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    expect(applied.some((migration) => migration.name === 'CreateDemoExpiryCleanup1710000034000')).toBe(true);

    quota = new TypeOrmStorageQuotaRepository(dataSource);
    roots = new TypeOrmStorageRootMappingRepository(dataSource);
    cancellation = { cancelRun: jest.fn(), cancelCommand: jest.fn() };
  }, 120_000);

  beforeEach(async () => {
    const source = requiredDataSource();
    await source.query('TRUNCATE TABLE "users" CASCADE');
    await source.query('DELETE FROM "demo_admission_counters"');
    await source.query(`INSERT INTO "showcase_versions" ("id","project_display","tasks","facts","content_digest","snapshot_bytes","item_count","file_count")
      VALUES ($1,'{"name":"admin fixture","objective":null}'::jsonb,'[]'::jsonb,'[]'::jsonb,repeat('a',64),0,0,0) ON CONFLICT ("id") DO NOTHING`, [SHOWCASE_VERSION_ID]);
    await source.query('UPDATE "showcase_publication" SET "current_version_id"=$1 WHERE "singleton_id"=true', [SHOWCASE_VERSION_ID]);
    await source.query(`INSERT INTO "users" ("id","scope_key","identifier","account_kind","role","display_name","password_hash") VALUES
      ($1,'account:task-3-5-regular','expiry-regular','regular','user','Regular fixture','fixture-hash'),
      ($2,'account:task-3-5-admin','expiry-admin','regular','admin','Admin fixture','fixture-hash')`, [REGULAR_OWNER_ID, ADMIN_OWNER_ID]);
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-3-5-demo-expiry-'));
    const legacyRoot = path.join(workspaceRoot, 'legacy');
    const managedRoot = path.join(workspaceRoot, 'managed');
    await fs.mkdir(legacyRoot);
    await fs.writeFile(path.join(legacyRoot, 'identity'), 'legacy-fixture\n');
    await fs.mkdir(managedRoot);
    await fs.writeFile(path.join(managedRoot, '.personal-ai-managed-storage-identity'), 'managed-fixture\n');
    workspace = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace', identityFile: '/workspace/identity', expectedIdentity: 'legacy-fixture',
      managedContainerRoot: '/account-workspaces', managedIdentityFile: '/account-workspaces/.personal-ai-managed-storage-identity',
      managedExpectedIdentity: 'managed-fixture', fileSystem: new VirtualWorkspaceFileSystem(legacyRoot, managedRoot)
    });
    recovery = new ProjectRecoveryCleaner(path.join(workspaceRoot, 'recovery'));
  });

  afterEach(async () => {
    if (!workspaceRoot) return;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = undefined;
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (!databaseCreated || !databaseUrl) return;
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string; readonly user: string; readonly owner: string | null; readonly exists: boolean;
      }>(`SELECT current_database() AS "database", current_user AS "user",
        (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname"=$1) AS "owner",
        EXISTS (SELECT 1 FROM "pg_database" WHERE "datname"=$1) AS "exists"`, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.owner !== 'home_test') {
        throw new Error('Refusing to remove the demo expiry database after its guarded identity changed.');
      }
      if (!identity.rows[0]?.exists) { databaseCreated = false; return; }
      await baseClient.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [DATABASE_NAME]);
      await baseClient.query(`DROP DATABASE "${DATABASE_NAME}"`);
      databaseCreated = false;
    } finally {
      await baseClient.end();
    }
  }, 30_000);

  it('finalizes an expired owner as a replay tombstone without resetting counters or touching other accounts', async () => {
    const source = requiredDataSource();
    await seedDemo(source, { copy: false });
    await source.query('INSERT INTO "sessions" ("user_id","token_hash","expires_at") VALUES ($1,$2,clock_timestamp()-interval \'1 minute\')', [DEMO_OWNER_ID, 'expired-demo-session-hash']);
    const counterBaseline = await source.query(`SELECT "scope_kind","scope_key","window_seconds","window_start","count","max_count"
      FROM "demo_admission_counters" ORDER BY "scope_kind","scope_key"`);
    const regularCountBefore = await scalarCount(source, 'users', REGULAR_OWNER_ID);
    const adminCountBefore = await scalarCount(source, 'users', ADMIN_OWNER_ID);
    const showcaseBefore = await scalarCount(source, 'showcase_versions', SHOWCASE_VERSION_ID);

    const repository = createCleanupRepository();
    const firstResult = await repository.runBatch(cancellation, 2);
    const firstJobs = await source.query('SELECT "phase","failure_code" FROM "demo_expiry_cleanups" WHERE "admission_id"=$1', [DEMO_ADMISSION_ID]);
    expect({ firstResult, firstJobs }).toEqual({ firstResult: 1, firstJobs: [] });
    const admission = await source.query(`SELECT "status","failure_code","owner_id" FROM "demo_admissions" WHERE "id"=$1`, [DEMO_ADMISSION_ID]);
    expect(admission).toEqual([{ status: 'failed', failure_code: 'expired', owner_id: null }]);
    await expect(scalarCount(source, 'users', DEMO_OWNER_ID)).resolves.toBe(0);
    await expect(scalarCount(source, 'sessions', DEMO_OWNER_ID, 'user_id')).resolves.toBe(0);
    await expect(scalarCount(source, 'users', REGULAR_OWNER_ID)).resolves.toBe(regularCountBefore);
    await expect(scalarCount(source, 'users', ADMIN_OWNER_ID)).resolves.toBe(adminCountBefore);
    await expect(scalarCount(source, 'showcase_versions', SHOWCASE_VERSION_ID)).resolves.toBe(showcaseBefore);
    await expect(source.query(`SELECT "scope_kind","scope_key","window_seconds","window_start","count","max_count"
      FROM "demo_admission_counters" ORDER BY "scope_kind","scope_key"`)).resolves.toEqual(counterBaseline);

    const bootstrap = { initializeEmptyAccount: jest.fn() };
    const replay = new CreateDemoSessionUseCase(new TypeOrmDemoAdmissionRepository(source), bootstrap, {} as never, {});
    await expect(replay.execute({ idempotencyKey: IDEMPOTENCY_KEY, clientIp: '127.0.0.1' })).resolves.toEqual({ kind: 'status', state: 'failed' });
    expect(bootstrap.initializeEmptyAccount).not.toHaveBeenCalled();
    await expect(scalarCount(source, 'users', DEMO_OWNER_ID)).resolves.toBe(0);
    await expect(source.query(`SELECT "singleton_id" FROM "showcase_publication" WHERE "current_version_id"=$1`, [SHOWCASE_VERSION_ID])).resolves.toHaveLength(1);
  });

  it('retains settled demo credit history, waits on unresolved calls, and replays after owner detachment', async () => {
    const source = requiredDataSource();
    await source.query('UPDATE "credit_runtime_policy" SET "inference_paused"=false,"demo_daily_limit_units"=1000000,"demo_campaign_limit_units"=1000000,"demo_campaign_id"=$1,"demo_max_concurrent_calls"=4 WHERE "id"=1', [CREDIT_CAMPAIGN_ID]);
    await seedDemo(source, { copy: false, expiresAt: new Date(Date.now() + 60_000) });
    await seedRegularProject(source);
    const regularProjectRoot = path.join(workspaceRoot!, 'managed', REGULAR_OWNER_ID, 'projects', REGULAR_PROJECT_ID);
    await fs.mkdir(regularProjectRoot, { recursive: true });
    await fs.writeFile(path.join(regularProjectRoot, 'keep.txt'), 'regular owner data');

    const credit = new TypeOrmCreditLedgerRepository(source);
    const settledCall = await credit.reserveProviderCall(creditCommand(DEMO_OWNER_ID, CREDIT_SOURCE_ONE, 'settled-call'));
    await expect(credit.settleProviderCall({
      reservationId: settledCall.reservationId, usage: { promptTokens: 3, completionTokens: 2 }
    })).resolves.toEqual({ outcome: 'settled', chargedUnits: 5n });
    const unresolvedCall = await credit.reserveProviderCall(creditCommand(DEMO_OWNER_ID, CREDIT_SOURCE_TWO, 'unresolved-call'));
    await source.query('INSERT INTO "sessions" ("user_id","token_hash","expires_at") VALUES ($1,$2,$3)',
      [DEMO_OWNER_ID, 'settled-demo-credit-session-hash', new Date(Date.now() + 86_400_000)]);
    const expiredAt = new Date(Date.now() - 1_000);
    await source.query('UPDATE "users" SET "expires_at"=$2 WHERE "id"=$1', [DEMO_OWNER_ID, expiredAt]);
    await source.query('UPDATE "demo_admissions" SET "expires_at"=$2 WHERE "id"=$1', [DEMO_ADMISSION_ID, expiredAt]);

    const counterBaseline = await source.query('SELECT "scope_kind","scope_key","window_seconds","window_start","count","max_count" FROM "demo_admission_counters" ORDER BY "scope_kind","scope_key"');
    const regularAdminBaseline = await source.query('SELECT "id","account_kind","role" FROM "users" WHERE "id" IN ($1,$2) ORDER BY "id"',
      [REGULAR_OWNER_ID, ADMIN_OWNER_ID]);
    const showcaseBaseline = await source.query('SELECT v."id",p."current_version_id" FROM "showcase_versions" v CROSS JOIN "showcase_publication" p WHERE v."id"=$1 AND p."singleton_id"=true', [SHOWCASE_VERSION_ID]);
    const regularProjectBaseline = await source.query('SELECT "id","relative_root" FROM "projects" WHERE "owner_id"=$1', [REGULAR_OWNER_ID]);

    await expect(createCleanupRepository().runBatch(cancellation, 2)).resolves.toBe(0);
    await expect(source.query('SELECT "phase","failure_code" FROM "demo_expiry_cleanups" WHERE "admission_id"=$1', [DEMO_ADMISSION_ID]))
      .resolves.toEqual([{ phase: 'draining', failure_code: 'busy' }]);
    await expect(source.query('SELECT "owner_id" FROM "credit_provider_call_reservations" WHERE "id"=$1', [unresolvedCall.reservationId]))
      .resolves.toEqual([{ owner_id: DEMO_OWNER_ID }]);

    await credit.retainUnknown(unresolvedCall.reservationId, 'network_lost');
    await source.query('UPDATE "demo_expiry_cleanups" SET "next_attempt_at"=clock_timestamp() WHERE "admission_id"=$1', [DEMO_ADMISSION_ID]);
    await expect(createCleanupRepository().runBatch(cancellation, 2)).resolves.toBe(0);
    await expect(source.query('SELECT "phase","failure_code" FROM "demo_expiry_cleanups" WHERE "admission_id"=$1', [DEMO_ADMISSION_ID]))
      .resolves.toEqual([{ phase: 'draining', failure_code: 'unknown_effect' }]);
    await expect(source.query('SELECT "owner_id" FROM "credit_provider_call_reservations" WHERE "id"=$1', [unresolvedCall.reservationId]))
      .resolves.toEqual([{ owner_id: DEMO_OWNER_ID }]);

    await expect(credit.settleProviderCall({
      reservationId: unresolvedCall.reservationId, usage: { promptTokens: 2, completionTokens: 1 }
    })).resolves.toEqual({ outcome: 'settled', chargedUnits: 3n });
    const ledgerSql = [
      'SELECT r."id" AS "reservation_id",r."owner_id" AS "reservation_owner_id",r."status",',
      'r."reserved_units",r."actual_input_tokens",r."actual_output_tokens",r."charged_units",r."demo_campaign_id",',
      'u."owner_id" AS "usage_owner_id",u."source_kind",u."source_id",u."call_id",u."attempt_id",',
      'u."input_tokens",u."output_tokens",u."total_tokens",u."price_version",',
      'u."input_units_per_million_tokens",u."output_units_per_million_tokens",u."charged_units" AS "usage_charged_units"',
      'FROM "credit_provider_call_reservations" r JOIN "credit_usage_entries" u ON u."reservation_id"=r."id"',
      'WHERE r."id" IN ($1,$2) ORDER BY r."id"'
    ].join(' ');
    const ledgerBeforeCleanup = await source.query(ledgerSql, [settledCall.reservationId, unresolvedCall.reservationId]);
    expect(ledgerBeforeCleanup).toHaveLength(2);
    const dailyCreditBaseline = await source.query('SELECT "window_start","window_end","settled_units","reserved_units" FROM "credit_demo_daily_windows" ORDER BY "window_start"');
    const campaignCreditBaseline = await source.query('SELECT "campaign_id","settled_units","reserved_units" FROM "credit_demo_campaign_usage" ORDER BY "campaign_id"');
    await source.query('UPDATE "demo_expiry_cleanups" SET "next_attempt_at"=clock_timestamp() WHERE "admission_id"=$1', [DEMO_ADMISSION_ID]);

    await expect(createCleanupRepository().runBatch(cancellation, 2)).resolves.toBe(1);

    const ledgerAfterCleanup = await source.query(ledgerSql, [settledCall.reservationId, unresolvedCall.reservationId]);
    expect(ledgerAfterCleanup).toEqual(ledgerBeforeCleanup.map((row: Record<string, unknown>) => ({
      ...row, reservation_owner_id: null, usage_owner_id: null
    })));
    await expect(source.query('SELECT "window_start","window_end","settled_units","reserved_units" FROM "credit_demo_daily_windows" ORDER BY "window_start"'))
      .resolves.toEqual(dailyCreditBaseline);
    await expect(source.query('SELECT "campaign_id","settled_units","reserved_units" FROM "credit_demo_campaign_usage" ORDER BY "campaign_id"'))
      .resolves.toEqual(campaignCreditBaseline);
    await expect(source.query('SELECT "owner_id" FROM "credit_account_totals" WHERE "owner_id"=$1', [DEMO_OWNER_ID])).resolves.toHaveLength(0);
    await expect(source.query('SELECT "status","failure_code","owner_id" FROM "demo_admissions" WHERE "id"=$1', [DEMO_ADMISSION_ID]))
      .resolves.toEqual([{ status: 'failed', failure_code: 'expired', owner_id: null }]);
    await expect(source.query('SELECT "id" FROM "users" WHERE "id"=$1', [DEMO_OWNER_ID])).resolves.toHaveLength(0);
    await expect(source.query('SELECT "user_id" FROM "sessions" WHERE "user_id"=$1', [DEMO_OWNER_ID])).resolves.toHaveLength(0);
    await expect(source.query('SELECT "id","account_kind","role" FROM "users" WHERE "id" IN ($1,$2) ORDER BY "id"',
      [REGULAR_OWNER_ID, ADMIN_OWNER_ID])).resolves.toEqual(regularAdminBaseline);
    await expect(source.query('SELECT v."id",p."current_version_id" FROM "showcase_versions" v CROSS JOIN "showcase_publication" p WHERE v."id"=$1 AND p."singleton_id"=true', [SHOWCASE_VERSION_ID]))
      .resolves.toEqual(showcaseBaseline);
    await expect(source.query('SELECT "id","relative_root" FROM "projects" WHERE "owner_id"=$1', [REGULAR_OWNER_ID])).resolves.toEqual(regularProjectBaseline);
    await expect(fs.readFile(path.join(regularProjectRoot, 'keep.txt'), 'utf8')).resolves.toBe('regular owner data');
    await expect(source.query('SELECT "scope_kind","scope_key","window_seconds","window_start","count","max_count" FROM "demo_admission_counters" ORDER BY "scope_kind","scope_key"'))
      .resolves.toEqual(counterBaseline);

    await expect(credit.settleProviderCall({
      reservationId: settledCall.reservationId, usage: { promptTokens: 3, completionTokens: 2 }
    })).resolves.toEqual({ outcome: 'replayed', chargedUnits: 5n });
    await expect(credit.settleProviderCall({
      reservationId: unresolvedCall.reservationId, usage: { promptTokens: 2, completionTokens: 1 }
    })).resolves.toEqual({ outcome: 'replayed', chargedUnits: 3n });
    await expect(source.query('SELECT "window_start","window_end","settled_units","reserved_units" FROM "credit_demo_daily_windows" ORDER BY "window_start"'))
      .resolves.toEqual(dailyCreditBaseline);
    await expect(source.query('SELECT "campaign_id","settled_units","reserved_units" FROM "credit_demo_campaign_usage" ORDER BY "campaign_id"'))
      .resolves.toEqual(campaignCreditBaseline);

    const bootstrap = { initializeEmptyAccount: jest.fn() };
    const replay = new CreateDemoSessionUseCase(new TypeOrmDemoAdmissionRepository(source), bootstrap, {} as never, {});
    await expect(replay.execute({ idempotencyKey: IDEMPOTENCY_KEY, clientIp: '127.0.0.1' })).resolves.toEqual({ kind: 'status', state: 'failed' });
    expect(bootstrap.initializeEmptyAccount).not.toHaveBeenCalled();
    await expect(source.query('SELECT "id" FROM "users" WHERE "id"=$1', [DEMO_OWNER_ID])).resolves.toHaveLength(0);
    await expect(source.query('SELECT "user_id" FROM "sessions" WHERE "user_id"=$1', [DEMO_OWNER_ID])).resolves.toHaveLength(0);
    await expect(source.query('SELECT "scope_kind","scope_key","window_seconds","window_start","count","max_count" FROM "demo_admission_counters" ORDER BY "scope_kind","scope_key"'))
      .resolves.toEqual(counterBaseline);
  });

  it('holds an in-flight managed-root receipt, then resumes after restart and removes only that project child', async () => {
    const source = requiredDataSource();
    await seedDemo(source, { copy: true });
    const legacyRoot = path.join(workspaceRoot!, 'legacy');
    const managedRoot = path.join(workspaceRoot!, 'managed');
    const demoProjectRoot = path.join(managedRoot, DEMO_OWNER_ID, 'projects', COPY_PROJECT_ID);
    const regularProjectRoot = path.join(managedRoot, REGULAR_OWNER_ID, 'projects', REGULAR_PROJECT_ID);
    await fs.mkdir(demoProjectRoot, { recursive: true });
    await fs.writeFile(path.join(demoProjectRoot, 'pending.txt'), 'effect may still be completing');
    await fs.mkdir(regularProjectRoot, { recursive: true });
    await fs.writeFile(path.join(regularProjectRoot, 'keep.txt'), 'regular owner data');
    await seedRegularProject(source);

    const firstProcessRepository = createCleanupRepository();
    await expect(firstProcessRepository.runBatch(cancellation, 2)).resolves.toBe(0);
    const pendingJob = await source.query(`SELECT "phase","failure_code","lease_token" FROM "demo_expiry_cleanups" WHERE "admission_id"=$1`, [DEMO_ADMISSION_ID]);
    expect(pendingJob).toEqual([expect.objectContaining({ phase: 'draining', failure_code: 'unknown_effect', lease_token: null })]);
    await expect(fs.readFile(path.join(demoProjectRoot, 'pending.txt'), 'utf8')).resolves.toBe('effect may still be completing');
    await expect(scalarCount(source, 'users', DEMO_OWNER_ID)).resolves.toBe(1);

    await source.query(`UPDATE "demo_copy_effect_receipts" SET "outcome"='verified',"completed_at"=clock_timestamp(),"updated_at"=clock_timestamp()
      WHERE "admission_id"=$1 AND "outcome"='pending'`, [DEMO_ADMISSION_ID]);
    await source.query('UPDATE "demo_expiry_cleanups" SET "next_attempt_at"=clock_timestamp() WHERE "admission_id"=$1', [DEMO_ADMISSION_ID]);

    const restartedRepository = createCleanupRepository();
    const resumedResult = await restartedRepository.runBatch(cancellation, 2);
    const resumedJobs = await source.query('SELECT "phase","failure_code" FROM "demo_expiry_cleanups" WHERE "admission_id"=$1', [DEMO_ADMISSION_ID]);
    expect({ resumedResult, resumedJobs }).toEqual({ resumedResult: 1, resumedJobs: [] });
    await expect(fs.stat(demoProjectRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(regularProjectRoot, 'keep.txt'), 'utf8')).resolves.toBe('regular owner data');
    await expect(source.query('SELECT "root_key" FROM "storage_root_mappings" WHERE "owner_id"=$1', [REGULAR_OWNER_ID]))
      .resolves.toHaveLength(1);
    await expect(source.query('SELECT "id" FROM "projects" WHERE "owner_id"=$1 AND "id"=$2', [REGULAR_OWNER_ID, REGULAR_PROJECT_ID]))
      .resolves.toHaveLength(1);
    await expect(source.query('SELECT "status","failure_code","owner_id" FROM "demo_admissions" WHERE "id"=$1', [DEMO_ADMISSION_ID]))
      .resolves.toEqual([{ status: 'failed', failure_code: 'expired', owner_id: null }]);
    await expect(source.query('SELECT "id" FROM "showcase_versions" WHERE "id"=$1', [SHOWCASE_VERSION_ID])).resolves.toHaveLength(1);
  });

  function requiredDataSource(): DataSource {
    if (!dataSource) throw new Error('The guarded demo expiry database is not initialized.');
    return dataSource;
  }

  function createCleanupRepository(): TypeOrmDemoExpiryCleanupRepository {
    return new TypeOrmDemoExpiryCleanupRepository(requiredDataSource(), workspace, recovery, roots, quota);
  }
});

async function seedDemo(source: DataSource, input: { readonly copy: boolean; readonly expiresAt?: Date }): Promise<void> {
  const expiresAt = input.expiresAt ?? new Date(Date.now() - 1_000);
  await source.query(`INSERT INTO "users" ("id","scope_key","identifier","account_kind","role","display_name","password_hash","expires_at")
    VALUES ($1,'account:task-3-5-demo',NULL,'demo','user','Expired demo',NULL,$2)`, [DEMO_OWNER_ID, expiresAt]);
  await source.query('INSERT INTO "account_limits" ("owner_id") VALUES ($1)', [DEMO_OWNER_ID]);
  await source.query(`INSERT INTO "storage_account_totals" ("owner_id","accounting_state") VALUES ($1,'ready')
    ON CONFLICT ("owner_id") DO UPDATE SET "accounting_state"='ready'`, [DEMO_OWNER_ID]);
  await source.query(`UPDATE "storage_account_totals" SET "accounting_state"='ready' WHERE "owner_id"=$1`, [DEMO_OWNER_ID]);
  await source.query(`INSERT INTO "demo_admissions" ("id","request_key_digest","owner_id","network_key_id","network_hash","status","expires_at")
    VALUES ($1,$2,$3,repeat('1',16),repeat('2',64),'ready',$4)`, [DEMO_ADMISSION_ID, REQUEST_DIGEST, DEMO_OWNER_ID, expiresAt]);
  await source.query(`INSERT INTO "demo_admission_counters" ("scope_kind","scope_key","network_key_id","window_start","window_end","window_seconds","max_count","count")
    SELECT 'global_admission','global',NULL,"window_start","window_start"+interval '3600 seconds',3600,20,3 FROM
      (SELECT to_timestamp(floor(extract(epoch FROM clock_timestamp())/3600)*3600) AS "window_start") w
    UNION ALL SELECT 'network_admission','2222222222222222',repeat('1',16),"window_start","window_start"+interval '900 seconds',900,10,2 FROM
      (SELECT to_timestamp(floor(extract(epoch FROM clock_timestamp())/900)*900) AS "window_start") w`);
  if (input.copy) {
    await source.query(`INSERT INTO "demo_showcase_copies" ("admission_id","owner_id","pinned_version_id","target_project_id","phase","claim_token","claim_expires_at","attempts","workspace_mode","file_access")
      VALUES ($1,$2,$3,$4,'root_pending','d3550000-0000-4000-8000-000000000501',clock_timestamp()-interval '1 second',1,'file_backed',true)`,
    [DEMO_ADMISSION_ID, DEMO_OWNER_ID, SHOWCASE_VERSION_ID, COPY_PROJECT_ID]);
    await source.query(`INSERT INTO "demo_copy_effect_receipts" ("admission_id","owner_id","project_id","effect_kind","claim_token","outcome")
      VALUES ($1,$2,$3,'managed_project_root_create','d3550000-0000-4000-8000-000000000501','pending')`, [DEMO_ADMISSION_ID, DEMO_OWNER_ID, COPY_PROJECT_ID]);
  }
}

async function seedRegularProject(source: DataSource): Promise<void> {
  await source.query('INSERT INTO "account_limits" ("owner_id") VALUES ($1)', [REGULAR_OWNER_ID]);
  await source.query(`INSERT INTO "storage_account_totals" ("owner_id","accounting_state") VALUES ($1,'ready')
    ON CONFLICT ("owner_id") DO UPDATE SET "accounting_state"='ready'`, [REGULAR_OWNER_ID]);
  const relativeRoot = `projects/${REGULAR_PROJECT_ID}`;
  await source.query(`INSERT INTO "projects" ("id","owner_id","name","slug","relative_root","relative_root_key","storage_kind")
    VALUES ($1,$2,'Regular fixture','regular-fixture',$3,lower($3),'managed')`, [REGULAR_PROJECT_ID, REGULAR_OWNER_ID, relativeRoot]);
  await source.query(`INSERT INTO "storage_root_mappings" ("owner_id","project_id","locator_project_id","root_key","storage_kind","relative_root","state")
    VALUES ($1,$2,$2,lower($3),'managed',$3,'active')`, [REGULAR_OWNER_ID, REGULAR_PROJECT_ID, relativeRoot]);
}

async function scalarCount(source: DataSource, table: 'users' | 'sessions' | 'showcase_versions', id: string, column = 'id'): Promise<number> {
  const rows: readonly { readonly count: string }[] = await source.query(
    `SELECT count(*)::text AS "count" FROM "${table}" WHERE "${column}"=$1`, [id]
  );
  return Number(rows[0]?.count ?? 0);
}

function creditCommand(ownerId: string, sourceId: string, callId: string): CreditReservationCommand {
  return {
    ownerId, sourceKind: 'ai_run', sourceId, callId, attemptId: '1',
    providerProfile: 'task-3-5-fixture', model: 'task-3-5-fixture-model',
    price: { version: 'task-3-5-credit-retention-v1', inputUnitsPerMillionTokens: 1_000_000n, outputUnitsPerMillionTokens: 1_000_000n },
    inputBounderVersion: 'task-3-5-fixture-bound-v1', maxInputTokens: 100, maxOutputTokens: 100,
    maxAttemptsForSource: 1, maximumUnits: 100n
  };
}
