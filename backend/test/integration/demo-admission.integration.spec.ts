import { randomBytes, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmDemoAdmissionRepository } from '@/infrastructure/database/repositories/typeorm-demo-admission-repository';
import { TypeOrmAiRunRepository } from '@/infrastructure/database/repositories/typeorm-ai-run-repository';
import { TypeOrmConversationRepository } from '@/infrastructure/database/repositories/typeorm-conversation-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { TypeOrmDemoStorageBootstrap } from '@/infrastructure/database/typeorm-demo-storage-bootstrap';
import { OpaqueTokenProvider } from '@/infrastructure/auth/opaque-token-provider';
import { FakeAgentRuntime } from '@/infrastructure/sandbox/fake-agent-runtime';
import { InMemoryRunEventPublisher } from '@/infrastructure/ai-runs/in-memory-run-event-publisher';
import { CancelAiRunUseCase } from '@/modules/ai-runs/use-cases/cancel-ai-run-use-case';
import { StartAiRunUseCase } from '@/modules/ai-runs/use-cases/start-ai-run-use-case';
import type { StartRunUpdate, RunMutationResult } from '@/modules/ai-runs/repositories/ai-run-repository';
import { DemoAdmissionRateLimitedError, DemoAdmissionUnavailableError, DemoRunStartRateLimitedError } from '@/modules/demo/domain/demo-admission-errors';
import { CreateDemoSessionUseCase } from '@/modules/demo/use-cases/create-demo-session';

const DATABASE_NAME = 'home_history_task_3_3_demo_test';
const REGULAR_OWNER_ID = 'd3330000-0000-4000-8000-000000000101';
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

describeDatabase('Task 3.3 demo admission with PostgreSQL', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let admissionRepository: TypeOrmDemoAdmissionRepository;
  let quotaRepository: TypeOrmStorageQuotaRepository;
  let demoUseCase: CreateDemoSessionUseCase;
  let targetUrl: string;

  const limits = {
    globalAdmissionMax: 2,
    globalAdmissionWindowSeconds: 3600,
    networkAdmissionMax: 1,
    networkAdmissionWindowSeconds: 900,
    runStartMax: 1,
    runStartWindowSeconds: 3600
  } as const;
  const networkSecret = 'task-3-3-dedicated-network-hash-secret';
  const rotatedSecret = 'task-3-3-rotated-network-hash-secret';
  const tokenProvider = new OpaqueTokenProvider('task-3-3-test-session-hmac-secret-32-bytes');

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded demo admission database URL is required.');
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string;
        readonly user: string;
        readonly canCreateDatabase: boolean;
        readonly databaseExists: boolean;
      }>(`SELECT current_database() AS "database", current_user AS "user",
          (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname" = current_user) AS "canCreateDatabase",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "databaseExists"`, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.canCreateDatabase !== true || identity.rows[0]?.databaseExists) {
        throw new Error('The guarded demo admission role cannot safely create its isolated database.');
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
    expect(applied).toHaveLength(dataSource.migrations.length);

    quotaRepository = new TypeOrmStorageQuotaRepository(dataSource);
    const accounting = new TypeOrmStorageContentAccounting(dataSource, quotaRepository);
    const bootstrap = new TypeOrmDemoStorageBootstrap(dataSource, accounting, quotaRepository);
    admissionRepository = new TypeOrmDemoAdmissionRepository(dataSource, limits);
    demoUseCase = new CreateDemoSessionUseCase(admissionRepository, bootstrap, tokenProvider, {
      limits,
      networkHashSecret: networkSecret,
      lifetimeMs: 24 * 60 * 60 * 1000
    });
  }, 120_000);

  beforeEach(async () => {
    await requiredDataSource().query('TRUNCATE TABLE "users" CASCADE');
    await requiredDataSource().query('TRUNCATE TABLE "demo_admission_counters" CASCADE');
    await requiredDataSource().query(`
      INSERT INTO "users" ("id", "scope_key", "identifier", "account_kind", "role", "display_name", "password_hash")
      VALUES ($1, 'account:task-3-3-regular', 'task-regular', 'regular', 'user', 'Regular fixture', 'fixture-hash')
    `, [REGULAR_OWNER_ID]);
    await requiredDataSource().query('INSERT INTO "account_limits" ("owner_id") VALUES ($1)', [REGULAR_OWNER_ID]);
  });

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
      }>(`SELECT current_database() AS "database", current_user AS "user",
          (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname" = $1) AS "owner",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "exists"`, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.owner !== 'home_test') {
        throw new Error('Refusing to remove the demo database after its guarded identity changed.');
      }
      if (!identity.rows[0]?.exists) { databaseCreated = false; return; }
      await baseClient.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [DATABASE_NAME]);
      await baseClient.query(`DROP DATABASE "${DATABASE_NAME}"`);
      databaseCreated = false;
    } finally {
      await baseClient.end();
    }
  }, 30_000);

  it('serializes cross-network duplicate keys, enforces fixed-window counters, and makes the owner storage-ready once', async () => {
    const firstKey = randomBytes(32).toString('base64url');
    const secondKey = randomBytes(32).toString('base64url');
    const thirdKey = randomBytes(32).toString('base64url');
    const concurrent = await Promise.all([
      demoUseCase.execute({ idempotencyKey: firstKey, clientIp: '198.51.100.40' }),
      demoUseCase.execute({ idempotencyKey: firstKey, clientIp: '203.0.113.90' })
    ]);
    const created = concurrent.filter((result) => result.kind === 'created');
    const statusOnly = concurrent.filter((result) => result.kind === 'status');
    expect(created).toHaveLength(1);
    expect(statusOnly).toHaveLength(1);
    expect(statusOnly[0]).toMatchObject({ kind: 'status', state: expect.stringMatching(/^(pending|ready)$/u) });
    const ownerId = created[0]?.kind === 'created' ? created[0].session.principal.id : '';
    expect(ownerId).toMatch(/^[0-9a-f-]{36}$/u);

    const accountRows: readonly {
      readonly demo_users: number;
      readonly admissions: number;
      readonly sessions: number;
      readonly counters: number;
      readonly raw_key_retained: boolean;
      readonly expiries_match: boolean;
      readonly ready_state: boolean;
      readonly inference_paused: boolean;
    }[] = await dataSource!.query(`
      SELECT
        (SELECT count(*)::int FROM "users" WHERE "account_kind" = 'demo') AS "demo_users",
        (SELECT count(*)::int FROM "demo_admissions") AS "admissions",
        (SELECT count(*)::int FROM "sessions" s JOIN "users" u ON u."id" = s."user_id" WHERE u."account_kind" = 'demo') AS "sessions",
        (SELECT count(*)::int FROM "demo_admission_counters") AS "counters",
        EXISTS (SELECT 1 FROM "demo_admissions" WHERE "request_key_digest" = $1) AS "raw_key_retained",
        (SELECT u."expires_at" = s."expires_at" AND s."expires_at" = a."expires_at"
           FROM "users" u JOIN "sessions" s ON s."user_id" = u."id"
           JOIN "demo_admissions" a ON a."owner_id" = u."id" WHERE u."id" = $2) AS "expiries_match",
        (SELECT t."accounting_state" = 'ready' AND t."used_bytes" = 0 AND t."reserved_bytes" = 0
           FROM "storage_account_totals" t WHERE t."owner_id" = $2) AS "ready_state",
        (SELECT "inference_paused" FROM "credit_runtime_policy" WHERE "id" = 1) AS "inference_paused"
    `, [firstKey, ownerId]);
    expect(accountRows[0]).toEqual({
      demo_users: 1, admissions: 1, sessions: 1, counters: 2,
      raw_key_retained: false, expiries_match: true, ready_state: true, inference_paused: true
    });
    const usage = await quotaRepository.readUsage(ownerId);
    expect(usage).toMatchObject({ state: 'ready', usedBytes: 0n, reservedBytes: 0n });

    await expect(demoUseCase.execute({ idempotencyKey: firstKey, clientIp: '192.0.2.55' }))
      .resolves.toEqual({ kind: 'status', state: 'ready' });
    await expect(demoUseCase.execute({ idempotencyKey: secondKey, clientIp: '198.51.100.40' }))
      .rejects.toThrow(DemoAdmissionRateLimitedError);
    const rotatedUseCase = new CreateDemoSessionUseCase(
      admissionRepository,
      { initializeEmptyAccount: async () => undefined },
      tokenProvider,
      { limits, networkHashSecret: rotatedSecret, lifetimeMs: 24 * 60 * 60 * 1000 }
    );
    await expect(rotatedUseCase.execute({ idempotencyKey: thirdKey, clientIp: '192.0.2.56' }))
      .rejects.toThrow(DemoAdmissionUnavailableError);

    const secondOwner = await demoUseCase.execute({ idempotencyKey: secondKey, clientIp: '203.0.113.40' });
    expect(secondOwner.kind).toBe('created');
    const globalLimitKey = randomBytes(32).toString('base64url');
    await expect(demoUseCase.execute({ idempotencyKey: globalLimitKey, clientIp: '192.0.2.99' }))
      .rejects.toThrow(DemoAdmissionRateLimitedError);
    const finalRows: readonly { readonly users: number; readonly admissions: number; readonly global_count: number }[] = await dataSource!.query(`
      SELECT (SELECT count(*)::int FROM "users" WHERE "account_kind" = 'demo') AS "users",
        (SELECT count(*)::int FROM "demo_admissions") AS "admissions",
        (SELECT "count" FROM "demo_admission_counters" WHERE "scope_kind" = 'global_admission') AS "global_count"
    `);
    expect(finalRows).toEqual([{ users: 2, admissions: 2, global_count: 2 }]);
  }, 30_000);

  it('serializes demo run-start caps by owner and leaves regular owners outside that counter', async () => {
    const ready = await demoUseCase.execute({ idempotencyKey: randomBytes(32).toString('base64url'), clientIp: '198.51.100.70' });
    if (ready.kind !== 'created') throw new Error('The run-start fixture did not create its demo identity.');
    const ownerId = ready.session.principal.id;
    const runIds = [randomUUID(), randomUUID()];
    const starts = await Promise.allSettled(runIds.map((runId) => admissionRepository.admitDemoRunStart(ownerId, runId)));
    expect(starts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(starts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = starts.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.any(DemoRunStartRateLimitedError) });

    const rowsBefore = await dataSource!.query('SELECT count(*)::int AS "count" FROM "demo_run_start_events" WHERE "owner_id" = $1', [ownerId]);
    expect(rowsBefore).toEqual([{ count: 1 }]);
    const regularRunId = randomUUID();
    await expect(admissionRepository.admitDemoRunStart(REGULAR_OWNER_ID, regularRunId)).resolves.toBeUndefined();
    const rowsAfter = await dataSource!.query('SELECT count(*)::int AS "count" FROM "demo_run_start_events" WHERE "owner_id" = $1', [REGULAR_OWNER_ID]);
    expect(rowsAfter).toEqual([{ count: 0 }]);
  }, 30_000);

  it('does not consume a demo run-start slot when cancellation commits before beginStart', async () => {
    const admitted = await demoUseCase.execute({ idempotencyKey: randomBytes(32).toString('base64url'), clientIp: '198.51.100.81' });
    if (admitted.kind !== 'created') throw new Error('The demo race fixture did not create its identity.');
    const ownerId = admitted.session.principal.id;
    const projectId = randomUUID();
    const conversationId = randomUUID();
    const runId = randomUUID();
    const relativeRoot = `projects/${projectId}`;
    const rootKey = relativeRoot.toLocaleLowerCase('en-US');
    await dataSource!.query(`
      INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind")
      VALUES ($1, $2, 'Race fixture', $3, $4, $5, 'managed')
    `, [projectId, ownerId, `race-${projectId}`, relativeRoot, rootKey]);
    await dataSource!.query(`
      INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
      VALUES ($1, $2, $2, $3, 'managed', $4, 'active')
    `, [ownerId, projectId, rootKey, relativeRoot]);
    await dataSource!.query(`
      INSERT INTO "conversations" ("id", "owner_id", "project_id", "title") VALUES ($1, $2, $3, 'Race fixture')
    `, [conversationId, ownerId, projectId]);
    const manifest = {
      manifestHash: 'a'.repeat(64), provider: 'NVIDIA hosted NIM', providerProfile: 'nvidia-hosted-nim',
      model: 'nvidia/nemotron-3-super-120b-a12b', categories: ['Request'], files: [], requestBytes: 0,
      messageBytes: 0, messageCount: 0, messageHash: 'b'.repeat(64), byteEstimate: 0, tokenEstimate: 0,
      excludedItemCount: 0, omittedItemCount: 0, omissionSummary: 'No selected items were excluded.',
      bestEffortSecretDetection: true
    };
    await dataSource!.query(`
      INSERT INTO "ai_runs" (
        "id", "owner_id", "project_id", "conversation_id", "request", "relative_root", "storage_kind",
        "requested_paths", "manifest", "manifest_hash", "status", "phase", "decision", "runtime_kind",
        "sandbox_ready", "safe_message", "create_idempotency_key", "request_fingerprint"
      ) VALUES ($1, $2, $3, $4, 'race test', $5, 'managed', '[]'::jsonb, $6::jsonb, $7, 'ready', 'runtime', 'approved', 'fake', true, 'Ready', $8, $9)
    `, [runId, ownerId, projectId, conversationId, relativeRoot, JSON.stringify(manifest), manifest.manifestHash, `create-${runId}`, 'c'.repeat(64)]);

    let releaseBeginStart!: () => void;
    let signalBeginStart!: () => void;
    const beginStartPaused = new Promise<void>((resolve) => { signalBeginStart = resolve; });
    const beginStartGate = new Promise<void>((resolve) => { releaseBeginStart = resolve; });
    class PausedBeginStartRepository extends TypeOrmAiRunRepository {
      public override async beginStart(input: StartRunUpdate): Promise<RunMutationResult> {
        signalBeginStart();
        await beginStartGate;
        return super.beginStart(input);
      }
    }

    const repository = new TypeOrmAiRunRepository(dataSource!);
    const pausedRepository = new PausedBeginStartRepository(dataSource!);
    const runtime = new FakeAgentRuntime();
    const events = new InMemoryRunEventPublisher();
    const start = new StartAiRunUseCase(pausedRepository, new TypeOrmConversationRepository(dataSource!), runtime, events, admissionRepository);
    const cancel = new CancelAiRunUseCase(repository, runtime, events);
    const pendingStart = start.execute({ ownerId, runId, idempotencyKey: `start-${runId}` });
    await beginStartPaused;
    await cancel.execute({ ownerId, runId, idempotencyKey: `cancel-${runId}` });
    releaseBeginStart();

    await expect(pendingStart).rejects.toMatchObject({ code: 'AI_RUN_STATE_CONFLICT' });
    expect(runtime.startedRuns).toEqual([]);
    const finalState: readonly { readonly status: string; readonly start_idempotency_key: string | null }[] = await dataSource!.query(
      'SELECT "status", "start_idempotency_key" FROM "ai_runs" WHERE "id" = $1 AND "owner_id" = $2', [runId, ownerId]
    );
    expect(finalState).toEqual([{ status: 'cancelled', start_idempotency_key: null }]);
    const runStartEvents: readonly { readonly count: number }[] = await dataSource!.query(
      'SELECT count(*)::int AS "count" FROM "demo_run_start_events" WHERE "owner_id" = $1 AND "run_id" = $2', [ownerId, runId]
    );
    expect(runStartEvents).toEqual([{ count: 0 }]);
  }, 30_000);

  function requiredDataSource(): DataSource {
    if (!dataSource?.isInitialized) throw new Error('The guarded demo database is not initialized.');
    return dataSource;
  }
});
