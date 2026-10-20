import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmProjectRemovalRepository } from '@/infrastructure/database/repositories/typeorm-project-removal-repository';
import { TypeOrmAutomationRepository } from '@/infrastructure/database/repositories/typeorm-automation-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { DeleteProjectUseCase } from '@/modules/projects/use-cases/delete-project';
import type { IProjectRecoveryCleaner } from '@/modules/projects/repositories/project-removal-repository';

const DATABASE_NAME = 'home_history_task_7_1_scheduler_test';
const OWNER_ID = 'd7710000-0000-4000-8000-000000000101';
const OTHER_OWNER_ID = 'd7710000-0000-4000-8000-000000000102';
const WORKSPACE_ID = 'd7710000-0000-4000-8000-000000000201';
const SKILL_ID = 'd7710000-0000-4000-8000-000000000301';
const REVISION_ID = 'd7710000-0000-4000-8000-000000000302';
const CONVERSATION_ID = 'd7710000-0000-4000-8000-000000000401';
const TURN_ID = 'd7710000-0000-4000-8000-000000000402';
const INVOCATION_ID = 'd7710000-0000-4000-8000-000000000403';
const SCHEDULE_ID = 'd7710000-0000-4000-8000-000000000501';
const OCCURRENCE_ID = 'd7710000-0000-4000-8000-000000000502';
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

const RESTART_WORKER_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
  } }).outputText;
  module._compile(output, filename);
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  const mapped = request.startsWith('@/') ? path.resolve(process.cwd(), 'src', request.slice(2)) : request;
  return resolve.call(this, mapped, parent, isMain, options);
};
(async () => {
  const { DataSource } = require('typeorm');
  const { TypeOrmAutomationRepository } = require('./src/infrastructure/database/repositories/typeorm-automation-repository.ts');
  const { AutomationWorker } = require('./src/modules/automations/use-cases/automation-worker.ts');
  const source = new DataSource({ type: 'postgres', url: process.env.AUTOMATION_WORKER_DATABASE_URL, logging: false });
  await source.initialize();
  let invokeCalls = 0;
  let pollCalls = 0;
  const worker = new AutomationWorker(
    new TypeOrmAutomationRepository(source),
    { execute: async () => { invokeCalls += 1; throw new Error('unexpected dispatch'); } },
    { execute: async () => { pollCalls += 1; return { status: 'unknown' }; } },
    { execute: async () => ({ resource: { status: 'unknown' } }) }
  );
  const claimed = await worker.runOnce();
  await source.destroy();
  process.stdout.write(JSON.stringify({ claimed, invokeCalls, pollCalls }));
})().catch(async () => { process.exitCode = 1; });
`;

describeDatabase('Task 7.1 durable scheduler PostgreSQL integration', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let targetUrl: string;
  let quota: TypeOrmStorageQuotaRepository;
  let accounting: TypeOrmStorageContentAccounting;
  let automations: TypeOrmAutomationRepository;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded scheduler integration database URL is required.');
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
        throw new Error('The guarded scheduler test role cannot safely create its isolated database.');
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
    const migrations = await dataSource.runMigrations({ transaction: 'all' });
    expect(migrations.some((migration) => migration.name === 'CreateAutomations1710000038000')).toBe(true);
    quota = new TypeOrmStorageQuotaRepository(dataSource);
    accounting = new TypeOrmStorageContentAccounting(dataSource, quota);
    automations = new TypeOrmAutomationRepository(dataSource);
  }, 120_000);

  beforeEach(async () => {
    const source = requiredDataSource();
    await source.query('TRUNCATE TABLE "users" CASCADE');
    await source.query('DELETE FROM "demo_admission_counters"');
    await source.query(`
      INSERT INTO "users" ("id","scope_key","identifier","account_kind","role","display_name","password_hash") VALUES
        ($1,'account:scheduler-owner','scheduler-owner','regular','user','Scheduler owner','fixture-hash'),
        ($2,'account:scheduler-other','scheduler-other','regular','user','Other owner','fixture-hash')
    `, [OWNER_ID, OTHER_OWNER_ID]);
    await source.query('INSERT INTO "account_limits" ("owner_id","storage_limit_bytes") VALUES ($1,100000),($2,100000)', [OWNER_ID, OTHER_OWNER_ID]);
    await source.query(`INSERT INTO "storage_account_totals" ("owner_id","accounting_state") VALUES ($1,'ready'),($2,'ready')`, [OWNER_ID, OTHER_OWNER_ID]);
    await source.query(`INSERT INTO "projects" ("id","owner_id","name","slug","relative_root","relative_root_key")
      VALUES ($1,$2,'Scheduler workspace','scheduler-workspace',NULL,NULL)`, [WORKSPACE_ID, OWNER_ID]);
    await source.transaction(async (manager) => {
      await manager.query('INSERT INTO "skills" ("id","owner_id","workspace_id","current_version") VALUES ($1,$2,$3,1)', [SKILL_ID, OWNER_ID, WORKSPACE_ID]);
      await manager.query(`INSERT INTO "skill_revisions" ("id","owner_id","skill_id","version","title","instructions","enabled","declared_tools")
        VALUES ($1,$2,$3,1,'Daily reader','Summarize this workspace using read access only.',true,'["home_task_read"]'::jsonb)`, [REVISION_ID, OWNER_ID, SKILL_ID]);
    });
    await source.query(`INSERT INTO "home_conversations" ("id","owner_id","scope","workspace_id","title","create_request_key","create_request_fingerprint")
      VALUES ($1,$2,'workspace',$3,'Scheduled briefing','scheduler-conversation','a')`, [CONVERSATION_ID, OWNER_ID, WORKSPACE_ID]);
    await quota.reconcileReferences(OWNER_ID, await scanContent(OWNER_ID));
    await quota.reconcileReferences(OTHER_OWNER_ID, await scanContent(OTHER_OWNER_ID));
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
        throw new Error('Refusing to remove the scheduler test database after its guarded identity changed.');
      }
      if (!identity.rows[0]?.exists) { databaseCreated = false; return; }
      await baseClient.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [DATABASE_NAME]);
      await baseClient.query(`DROP DATABASE "${DATABASE_NAME}"`);
      databaseCreated = false;
    } finally {
      await baseClient.end();
    }
  }, 30_000);

  it('creates owner-scoped schedules and replays stable manual occurrence keys', async () => {
    const now = new Date(Date.now() + 86_400_000);
    const create = {
      ownerId: OWNER_ID, workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID, skillId: SKILL_ID,
      skillRevisionId: REVISION_ID, skillVersion: 1, localTime: '08:30', timeZone: 'America/Los_Angeles',
      nextDueAt: now, createKeyDigest: '1'.repeat(64), requestFingerprint: '2'.repeat(64)
    };
    const created = await automations.createSchedule(create);
    expect(created).toMatchObject({ replayed: false, schedule: { ownerId: OWNER_ID, workspaceId: WORKSPACE_ID, revision: 1 } });
    await expect(automations.createSchedule(create)).resolves.toMatchObject({ replayed: true, schedule: { id: created.schedule.id } });
    await expect(automations.createSchedule({ ...create, requestFingerprint: '3'.repeat(64) }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(automations.findSchedule(OTHER_OWNER_ID, created.schedule.id)).resolves.toBeNull();

    const manual = {
      ownerId: OWNER_ID, scheduleId: created.schedule.id, expectedRevision: 1,
      requestKeyDigest: '4'.repeat(64), requestFingerprint: '5'.repeat(64)
    };
    const firstRun = await automations.createManualOccurrence(manual);
    await expect(automations.createManualOccurrence(manual)).resolves.toMatchObject({ replayed: true, occurrence: { id: firstRun.occurrence.id } });
    await expect(automations.createManualOccurrence({ ...manual, requestFingerprint: '6'.repeat(64) }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('allows one current lease under concurrent repository claims and rejects the expired fence', async () => {
    const schedule = await createSchedule();
    const run = await automations.createManualOccurrence({
      ownerId: OWNER_ID, scheduleId: schedule.id, expectedRevision: 1,
      requestKeyDigest: '7'.repeat(64), requestFingerprint: '8'.repeat(64)
    });
    const secondDataSource = createDataSource({ url: targetUrl });
    await secondDataSource.initialize();
    try {
      const secondRepository = new TypeOrmAutomationRepository(secondDataSource);
      const [firstClaims, secondClaims] = await Promise.all([
        automations.claimBatch({ limit: 1, leaseMilliseconds: 30_000 }),
        secondRepository.claimBatch({ limit: 1, leaseMilliseconds: 30_000 })
      ]);
      const claims = [...firstClaims, ...secondClaims];
      expect(claims).toHaveLength(1);
      expect(claims[0]?.occurrence.id).toBe(run.occurrence.id);
      const previousFence = claims[0]!.fence;
      await requiredDataSource().query('UPDATE "automation_occurrences" SET "lease_expires_at"=clock_timestamp()-interval \'1 second\' WHERE "id"=$1', [run.occurrence.id]);
      const reclaimed = await secondRepository.claimBatch({ limit: 1, leaseMilliseconds: 30_000 });
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]?.fence.generation).toBe(previousFence.generation + 1);
      await expect(automations.heartbeat(previousFence, 30_000)).resolves.toBe(false);
      await expect(automations.beginDispatch(previousFence)).resolves.toBe(false);
      await expect(automations.recordTurnStatus({ ...previousFence, status: 'succeeded' })).resolves.toBe(false);
      await expect(secondRepository.beginDispatch(reclaimed[0]!.fence)).resolves.toBe(true);
    } finally {
      await secondDataSource.destroy();
    }
  });

  it('reconciles a linked uncertain turn in a fresh worker process without reinvoking the skill', async () => {
    const schedule = await createSchedule();
    const run = await automations.createManualOccurrence({
      ownerId: OWNER_ID, scheduleId: schedule.id, expectedRevision: 1,
      requestKeyDigest: '9'.repeat(64), requestFingerprint: 'a'.repeat(64)
    });
    const claimed = await automations.claimBatch({ limit: 1, leaseMilliseconds: 30_000 });
    expect(claimed).toHaveLength(1);
    expect(await automations.beginDispatch(claimed[0]!.fence)).toBe(true);
    const source = requiredDataSource();
    await source.query(`INSERT INTO "skill_invocations" ("id","owner_id","conversation_id","skill_id","skill_revision_id","skill_version",
      "request_key_digest","request_fingerprint","state") VALUES ($1,$2,$3,$4,$5,1,$6,$7,'accepted')`,
    [INVOCATION_ID, OWNER_ID, CONVERSATION_ID, SKILL_ID, REVISION_ID, 'b'.repeat(64), 'c'.repeat(64)]);
    await source.query(`INSERT INTO "home_turns" ("id","owner_id","conversation_id","sequence","request_key","request_fingerprint","status",
      "skill_invocation_id","automation_occurrence_id") VALUES ($1,$2,$3,1,'schedule-turn','d','running',$4,$5)`,
    [TURN_ID, OWNER_ID, CONVERSATION_ID, INVOCATION_ID, run.occurrence.id]);
    await source.query(`UPDATE "automation_occurrences" SET "status"='running',"skill_invocation_id"=$2,"home_turn_id"=$3,
      "lease_expires_at"=clock_timestamp()-interval '1 second' WHERE "id"=$1`, [run.occurrence.id, INVOCATION_ID, TURN_ID]);

    const child = spawnSync(process.execPath, ['-e', RESTART_WORKER_SCRIPT], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { ...process.env, AUTOMATION_WORKER_DATABASE_URL: targetUrl }, stdio: ['ignore', 'pipe', 'ignore']
    });
    if (child.error || child.status !== 0) throw new Error('The fresh-process scheduler reconciliation fixture failed.');
    const outcome = JSON.parse(child.stdout.trim()) as { readonly claimed: number; readonly invokeCalls: number; readonly pollCalls: number };
    expect(outcome).toEqual({ claimed: 1, invokeCalls: 0, pollCalls: 1 });
    await expect(source.query('SELECT "status","home_turn_id","skill_invocation_id" FROM "automation_occurrences" WHERE "id"=$1', [run.occurrence.id]))
      .resolves.toEqual([{ status: 'interrupted_unknown', home_turn_id: TURN_ID, skill_invocation_id: INVOCATION_ID }]);
    await expect(source.query('SELECT "id" FROM "home_turns" WHERE "automation_occurrence_id"=$1', [run.occurrence.id]))
      .resolves.toHaveLength(1);
  });

  it('fences workspace removal outside locks and retains the removal barrier for unknown cancellation', async () => {
    const schedule = await createSchedule();
    const run = await automations.createManualOccurrence({
      ownerId: OWNER_ID, scheduleId: schedule.id, expectedRevision: 1,
      requestKeyDigest: 'e'.repeat(64), requestFingerprint: 'f'.repeat(64)
    });
    await seedLinkedTurn(run.occurrence.id);
    const noFilesystem: IProjectRecoveryCleaner = {
      quarantine: async () => ({ restore: async () => undefined, purge: async () => undefined }),
      restore: async () => undefined, purge: async () => undefined
    };
    const repository = new TypeOrmProjectRemovalRepository(
      requiredDataSource(), noFilesystem, accounting, quota, new TypeOrmStorageRootMappingRepository(requiredDataSource())
    );
    const cancellation = {
      execute: jest.fn(async () => {
        const lockedSchedule = await requiredDataSource().transaction(async (manager) => await manager.query(
          'SELECT "id" FROM "automation_schedules" WHERE "id"=$1 FOR UPDATE NOWAIT', [schedule.id]
        ));
        expect(lockedSchedule).toHaveLength(1);
        await requiredDataSource().query('UPDATE "home_turns" SET "status"=\'unknown\' WHERE "id"=$1', [TURN_ID]);
        return { resource: { status: 'unknown' } };
      })
    };
    const deleteProject = new DeleteProjectUseCase(repository, cancellation as never);
    await expect(deleteProject.execute({ ownerId: OWNER_ID, projectId: WORKSPACE_ID, expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'PROJECT_REMOVAL_BUSY' });
    await expect(requiredDataSource().query('SELECT "status" FROM "automation_occurrences" WHERE "id"=$1', [run.occurrence.id]))
      .resolves.toEqual([{ status: 'interrupted_unknown' }]);
    await expect(requiredDataSource().query('SELECT "id" FROM "projects" WHERE "owner_id"=$1 AND "id"=$2', [OWNER_ID, WORKSPACE_ID]))
      .resolves.toHaveLength(1);
    await expect(requiredDataSource().query('SELECT "project_id" FROM "project_removal_jobs" WHERE "owner_id"=$1 AND "project_id"=$2', [OWNER_ID, WORKSPACE_ID]))
      .resolves.toHaveLength(1);

    const settledCancellation = async () => {
      await requiredDataSource().query('UPDATE "home_turns" SET "status"=\'cancelled\' WHERE "id"=$1', [TURN_ID]);
      return 'cancelled';
    };
    await expect(repository.cleanupPending(settledCancellation)).resolves.toBe(1);
    await expect(requiredDataSource().query('SELECT "status" FROM "automation_occurrences" WHERE "id"=$1', [run.occurrence.id]))
      .resolves.toEqual([{ status: 'cancelled' }]);
    await deleteProject.execute({ ownerId: OWNER_ID, projectId: WORKSPACE_ID, expectedVersion: 1 });
    await expect(requiredDataSource().query('SELECT "id" FROM "projects" WHERE "owner_id"=$1 AND "id"=$2', [OWNER_ID, WORKSPACE_ID]))
      .resolves.toHaveLength(0);
    await expect(requiredDataSource().query('SELECT "id" FROM "automation_schedules" WHERE "owner_id"=$1 AND "id"=$2', [OWNER_ID, schedule.id]))
      .resolves.toHaveLength(0);
  });

  async function createSchedule() {
    const result = await automations.createSchedule({
      ownerId: OWNER_ID, workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID, skillId: SKILL_ID,
      skillRevisionId: REVISION_ID, skillVersion: 1, localTime: '08:30', timeZone: 'UTC',
      nextDueAt: new Date(Date.now() + 86_400_000), createKeyDigest: 'a'.repeat(64), requestFingerprint: 'b'.repeat(64)
    });
    return result.schedule;
  }

  async function seedLinkedTurn(occurrenceId: string): Promise<void> {
    const source = requiredDataSource();
    await source.query(`INSERT INTO "skill_invocations" ("id","owner_id","conversation_id","skill_id","skill_revision_id","skill_version",
      "request_key_digest","request_fingerprint","state") VALUES ($1,$2,$3,$4,$5,1,$6,$7,'accepted')`,
    [INVOCATION_ID, OWNER_ID, CONVERSATION_ID, SKILL_ID, REVISION_ID, '1'.repeat(64), '2'.repeat(64)]);
    await source.query(`INSERT INTO "home_turns" ("id","owner_id","conversation_id","sequence","request_key","request_fingerprint","status",
      "skill_invocation_id","automation_occurrence_id") VALUES ($1,$2,$3,1,'schedule-turn','3','running',$4,$5)`,
    [TURN_ID, OWNER_ID, CONVERSATION_ID, INVOCATION_ID, occurrenceId]);
    await source.query(`UPDATE "automation_occurrences" SET "status"='running',"skill_invocation_id"=$2,"home_turn_id"=$3 WHERE "id"=$1`,
      [occurrenceId, INVOCATION_ID, TURN_ID]);
  }

  async function scanContent(ownerId: string) {
    const runner = requiredDataSource().createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      const references = await accounting.scanDatabaseContent(runner, ownerId);
      await runner.commitTransaction();
      return references;
    } catch (error: unknown) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  function requiredDataSource(): DataSource {
    if (!dataSource?.isInitialized) throw new Error('The guarded scheduler database is not initialized.');
    return dataSource;
  }
});
