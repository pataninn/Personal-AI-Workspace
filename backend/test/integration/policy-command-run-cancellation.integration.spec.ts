import 'reflect-metadata';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmAiRunRepository } from '@/infrastructure/database/repositories/typeorm-ai-run-repository';
import { TypeOrmAssistantScopePolicyRepository } from '@/infrastructure/database/repositories/typeorm-assistant-scope-policy-repository';
import { TypeOrmSandboxCommandRepository } from '@/infrastructure/database/repositories/typeorm-sandbox-command-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { StorageQuotaRootScanner, type TrustedStorageRoot } from '@/infrastructure/workspace/storage-quota-reconciliation';
import { SandboxCommandDecisionConflictError } from '@/modules/ai-runs/domain/command-errors';
import type { CommandResult } from '@/modules/ai-runs/domain/command-types';
import type { EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';

const DATABASE_NAME = 'home_history_task_4_1_command_cancel_test';
const OWNER_ID = '4a410000-0000-4000-8000-000000000201';
const PROJECT_ID = '4a410000-0000-4000-8000-000000000202';
const CONVERSATION_ID = '4a410000-0000-4000-8000-000000000203';
const PROVIDER_PROFILE = 'nim-pinned';
const MODEL = 'model-pinned';
const PROJECT_LOCK_SQL = 'SELECT "status", "relative_root" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1 FOR UPDATE';
const LATCH_KEY = '7411041041202401';
const DATABASE_URL = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
const describeDatabase = DATABASE_URL ? describe : describe.skip;

interface PgClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
}

interface UsageRow {
  readonly accounting_state: string;
  readonly used_bytes: string;
  readonly reserved_bytes: string;
}

interface ReferenceRow {
  readonly resource_kind: string;
  readonly resource_key: string;
  readonly copy_key: string;
  readonly byte_count: string;
  readonly sha256: string | null;
}

const { Client } = require('pg') as { readonly Client: new (options: { readonly connectionString: string }) => PgClient };

if (DATABASE_URL) assertGuardedBaseUrl(DATABASE_URL);

describeDatabase('policy-authorized sandbox command versus parent-run cancellation PostgreSQL integration', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let managedRoot: string | undefined;
  let runs: TypeOrmAiRunRepository;
  let commands: TypeOrmSandboxCommandRepository;
  let quota: TypeOrmStorageQuotaRepository;
  let accounting: TypeOrmStorageContentAccounting;
  let runId: string;
  let commandId: string;
  let proposalHash: string;

  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('The guarded command cancellation integration database URL is required.');
    await createIsolatedDatabase();
    databaseCreated = true;
    const target = new URL(DATABASE_URL);
    target.pathname = `/${DATABASE_NAME}`;
    dataSource = createDataSource({ url: target.toString() });
    await dataSource.initialize();
    const identity: readonly { readonly database: string; readonly user: string }[] = await dataSource.query(
      'SELECT current_database() AS "database", current_user AS "user"'
    );
    expect(identity).toEqual([{ database: DATABASE_NAME, user: 'home_test' }]);
    const migrations = await dataSource.runMigrations({ transaction: 'all' });
    expect(migrations).toHaveLength(dataSource.migrations.length);

    managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pai-policy-command-cancel-'));
    const projectRoot = path.join(managedRoot, OWNER_ID, ...`projects/${PROJECT_ID}`.split('/'));
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'README.md'), 'fixture command target\n', 'utf8');
    await seedOwnerProject(dataSource);

    quota = new TypeOrmStorageQuotaRepository(dataSource);
    accounting = new TypeOrmStorageContentAccounting(dataSource, quota);
    runs = new TypeOrmAiRunRepository(dataSource, undefined, accounting);
    commands = new TypeOrmSandboxCommandRepository(dataSource, accounting);
    const policies = new TypeOrmAssistantScopePolicyRepository(dataSource);
    const policy = await policies.fillConfiguredProvider({
      scope: { ownerId: OWNER_ID, scopeKind: 'project', projectId: PROJECT_ID },
      providerProfile: PROVIDER_PROFILE,
      model: MODEL
    });
    if (!policy) throw new Error('The project policy row is missing from the migration-created fixture.');

    const root: TrustedStorageRoot = {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      rootKey: `projects/${PROJECT_ID}`,
      absolutePath: projectRoot,
      classifyFile: () => 'project_file'
    };
    await reconcileOwner(dataSource, quota, accounting, [root]);
    await expect(quota.readUsage(OWNER_ID)).resolves.toMatchObject({ state: 'ready' });

    const createdRun = await runs.create({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      request: 'Inspect the fixture README.',
      relativeRoot: `projects/${PROJECT_ID}`,
      storageKind: 'managed',
      requestedPaths: ['README.md'],
      manifest: createManifest(),
      idempotencyKey: 'command-cancel-run',
      requestFingerprint: hash('command-cancel-run'),
      policyRevision: policy.revision
    });
    runId = createdRun.resource.id;
    await runs.save({ ...createdRun.resource, status: 'running', phase: 'runtime', safeMessage: 'Fixture run is active.' });

    proposalHash = hash('bounded read command proposal');
    const proposal = await commands.createProposal({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      runId,
      proposalHash,
      command: 'cat',
      args: ['README.md'],
      cwd: '.',
      summary: 'Read the fixture README.',
      classification: 'safe',
      limits: { wallTimeMs: 1000, idleTimeMs: 500, maxOutputBytes: 4096, maxProcesses: 1, memoryBytes: 1048576, cpuTimeMs: 1000, network: 'denied' },
      createIdempotencyKey: 'command-cancel-proposal',
      createFingerprint: hash('command-cancel-proposal')
    });
    commandId = proposal.resource.id;
    await expect(dataSource.query('SELECT "status", "decision", "policy_revision" FROM "ai_runs" WHERE "id" = $1', [runId]))
      .resolves.toEqual([{ status: 'running', decision: 'policy_authorized', policy_revision: policy.revision }]);
    await expect(quota.readUsage(OWNER_ID)).resolves.toMatchObject({ state: 'ready' });
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (databaseCreated && DATABASE_URL) {
      await dropIsolatedDatabase();
      databaseCreated = false;
    }
    if (managedRoot) {
      const resolved = path.resolve(managedRoot);
      const temporaryBase = `${path.resolve(os.tmpdir())}${path.sep}`;
      if (!resolved.startsWith(temporaryBase)) throw new Error('Refusing to remove a command fixture root outside the system temp directory.');
      await fs.rm(resolved, { recursive: true, force: true });
      managedRoot = undefined;
    }
  }, 30_000);

  it('commits parent cancellation before queued command claim and result-save can proceed', async () => {
    const source = requiredDataSource();
    const client = await openTargetClient();
    let latchHeld = false;
    let triggerInstalled = false;
    let cancelOutcome: Promise<PromiseOutcome<Awaited<ReturnType<TypeOrmAiRunRepository['requestCancellation']>>>> | undefined;
    let claimOutcome: Promise<PromiseOutcome<Awaited<ReturnType<TypeOrmSandboxCommandRepository['claimPolicyAuthorizedExecution']>>>> | undefined;
    let resultOutcome: Promise<PromiseOutcome<Awaited<ReturnType<TypeOrmSandboxCommandRepository['saveExecutionResult']>>>> | undefined;
    try {
      await client.query('SELECT pg_advisory_lock($1::bigint)', [LATCH_KEY]);
      latchHeld = true;
      await installCancellationTrigger(source);
      triggerInstalled = true;
      const runBefore = await runs.findByIdForOwner(OWNER_ID, runId);
      const commandBefore = await commands.findByIdForOwner(OWNER_ID, runId, commandId);
      const storageBefore = await storageSnapshot(source);
      expect(runBefore).toMatchObject({ status: 'running', decision: 'policy_authorized', policyRevision: expect.any(String) });
      expect(commandBefore).toMatchObject({ decision: 'pending', status: 'awaiting_approval', cancelRequested: false });
      expect(commandBefore?.result).toBeUndefined();

      cancelOutcome = observe(runs.requestCancellation({
        ownerId: OWNER_ID,
        runId,
        idempotencyKey: 'cancel-command-race',
        requestFingerprint: hash('cancel-command-race')
      }));
      const cancellationPid = await waitForCancellationTrigger(client);

      claimOutcome = observe(commands.claimPolicyAuthorizedExecution({
        ownerId: OWNER_ID,
        runId,
        commandId,
        proposalHash,
        idempotencyKey: 'claim-after-cancel',
        requestFingerprint: hash('claim-after-cancel')
      }));
      resultOutcome = observe(commands.saveExecutionResult({
        ownerId: OWNER_ID,
        runId,
        commandId,
        status: 'completed',
        result: commandResult(),
        safeMessage: 'The fixture command completed.'
      }));
      await waitForProjectLockWaiters(client, cancellationPid);

      await client.query('SELECT pg_advisory_unlock($1::bigint)', [LATCH_KEY]);
      latchHeld = false;
      const cancellation = await required(cancelOutcome);
      expect(cancellation.error).toBeUndefined();
      expect(cancellation.value?.resource.status).toBe('cancel_requested');

      const claim = await required(claimOutcome);
      expect(claim.value).toBeUndefined();
      expect(claim.error).toBeInstanceOf(SandboxCommandDecisionConflictError);
      const result = await required(resultOutcome);
      expect(result.error).toBeUndefined();
      expect(result.value).toBeNull();

      await expect(runs.findByIdForOwner(OWNER_ID, runId)).resolves.toMatchObject({ status: 'cancel_requested' });
      await expect(commands.findByIdForOwner(OWNER_ID, runId, commandId)).resolves.toEqual(commandBefore);
      await expect(storageSnapshot(source)).resolves.toEqual(storageBefore);
      await expect(fs.readFile(requiredProjectFile(), 'utf8')).resolves.toBe('fixture command target\n');
    } finally {
      if (latchHeld) await client.query('SELECT pg_advisory_unlock($1::bigint)', [LATCH_KEY]);
      await Promise.allSettled([cancelOutcome, claimOutcome, resultOutcome].filter(isDefined));
      if (triggerInstalled) await removeCancellationTrigger(source);
      await client.end();
    }
  }, 30_000);

  function requiredDataSource(): DataSource {
    if (!dataSource) throw new Error('The isolated command cancellation database was not initialized.');
    return dataSource;
  }

  function required<T>(value: Promise<T> | undefined): Promise<T> {
    if (!value) throw new Error('A guarded command operation did not start.');
    return value;
  }

  function requiredProjectFile(): string {
    if (!managedRoot) throw new Error('The isolated command project root was not initialized.');
    return path.join(managedRoot, OWNER_ID, ...`projects/${PROJECT_ID}/README.md`.split('/'));
  }
});

type PromiseOutcome<T> = { readonly value: T; readonly error?: never } | { readonly value?: never; readonly error: unknown };

function observe<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error }));
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

async function openTargetClient(): Promise<PgClient> {
  if (!DATABASE_URL) throw new Error('The guarded command cancellation integration database URL is required.');
  const target = new URL(DATABASE_URL);
  target.pathname = `/${DATABASE_NAME}`;
  const client = new Client({ connectionString: target.toString() });
  await client.connect();
  return client;
}

async function waitForCancellationTrigger(client: PgClient): Promise<number> {
  return waitForPid(client, `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
    AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND wait_event = 'advisory'
    AND query LIKE 'UPDATE "ai_runs" SET "status"%'`);
}

async function waitForProjectLockWaiters(client: PgClient, cancellationPid: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const rows = await client.query<{ readonly pid: number }>(`WITH RECURSIVE blocked(pid) AS (
      SELECT activity.pid FROM pg_stat_activity activity WHERE $1 = ANY(pg_blocking_pids(activity.pid))
      UNION
      SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
    ) SELECT activity.pid FROM pg_stat_activity activity
      WHERE activity.datname = current_database() AND activity.pid <> pg_backend_pid()
        AND activity.wait_event_type = 'Lock'
        AND activity.query LIKE 'SELECT "status", "relative_root" FROM "projects"%'
        AND activity.pid IN (SELECT pid FROM blocked)`, [cancellationPid]);
    if (rows.rows.length === 2) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const diagnostic = await client.query<{ readonly state: string; readonly wait_event_type: string; readonly wait_event: string; readonly project_query: boolean; readonly run_query: boolean; readonly blocked_by_cancellation: boolean }>(
    `SELECT state, wait_event_type, wait_event,
      query LIKE 'SELECT "status", "relative_root" FROM "projects"%' AS project_query,
      query LIKE '%FROM "ai_runs"%' AS run_query,
      $1 = ANY(pg_blocking_pids(pid)) AS blocked_by_cancellation
     FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`, [cancellationPid]);
  throw new Error(`The actual command claim and result-save transactions did not both queue behind parent cancellation: ${JSON.stringify(diagnostic.rows)}`);
}

async function waitForPid(client: PgClient, sql: string): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const rows = await client.query<{ readonly pid: number }>(sql);
    if (rows.rows.length === 1) return Number(rows.rows[0]?.pid);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The real parent cancellation transaction did not reach the post-update latch.');
}

async function installCancellationTrigger(dataSource: DataSource): Promise<void> {
  await dataSource.query(`CREATE FUNCTION task_4_1_pause_cancel_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."owner_id" = '${OWNER_ID}'::uuid AND NEW."status"::text = 'cancel_requested' AND OLD."status" IS DISTINCT FROM NEW."status" THEN
        PERFORM pg_advisory_xact_lock(${LATCH_KEY}::bigint);
      END IF;
      RETURN NEW;
    END;
  $$`);
  await dataSource.query(`CREATE TRIGGER task_4_1_pause_cancel_update AFTER UPDATE OF "status" ON "ai_runs"
    FOR EACH ROW EXECUTE FUNCTION task_4_1_pause_cancel_update()`);
}

async function removeCancellationTrigger(dataSource: DataSource): Promise<void> {
  await dataSource.query('DROP TRIGGER IF EXISTS task_4_1_pause_cancel_update ON "ai_runs"');
  await dataSource.query('DROP FUNCTION IF EXISTS task_4_1_pause_cancel_update()');
}

async function createIsolatedDatabase(): Promise<void> {
  await withBaseClient(async (client) => {
    const rows = await client.query<{ readonly database: string; readonly user: string; readonly canCreateDatabase: boolean; readonly exists: boolean }>(
      `SELECT current_database() AS "database", current_user AS "user",
       (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname" = current_user) AS "canCreateDatabase",
       EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "exists"`, [DATABASE_NAME]);
    const identity = rows.rows[0];
    if (identity?.database !== 'home_history_test' || identity.user !== 'home_test' || identity.canCreateDatabase !== true || identity.exists) {
      throw new Error('Refusing to create the command cancellation database outside the absent isolated home_test fixture.');
    }
    await client.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "home_test"`);
  });
}

async function dropIsolatedDatabase(): Promise<void> {
  await withBaseClient(async (client) => {
    const rows = await client.query<{ readonly database: string; readonly user: string; readonly owner: string | null; readonly exists: boolean }>(
      `SELECT current_database() AS "database", current_user AS "user",
       (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname" = $1) AS "owner",
       EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "exists"`, [DATABASE_NAME]);
    const identity = rows.rows[0];
    if (identity?.database !== 'home_history_test' || identity.user !== 'home_test' || identity.owner !== 'home_test') {
      throw new Error('Refusing to remove the command cancellation database because its guarded identity changed.');
    }
    if (!identity.exists) return;
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [DATABASE_NAME]);
    await client.query(`DROP DATABASE "${DATABASE_NAME}"`);
  });
}

async function withBaseClient<T>(operation: (client: PgClient) => Promise<T>): Promise<T> {
  if (!DATABASE_URL) throw new Error('The guarded command cancellation database URL is required.');
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function seedOwnerProject(dataSource: DataSource): Promise<void> {
  const relativeRoot = `projects/${PROJECT_ID}`;
  await dataSource.query(`INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash", "identifier", "account_kind", "role", "expires_at")
    VALUES ($1, 'local', 'Command cancellation fixture', 'fixture-hash', 'owner', 'regular', 'admin', NULL)`, [OWNER_ID]);
  await dataSource.query('INSERT INTO "account_limits" ("owner_id", "storage_limit_bytes") VALUES ($1, 1000000)', [OWNER_ID]);
  await dataSource.query(`INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind")
    VALUES ($1, $2, 'Command cancellation project', 'command-cancellation', $3, $3, 'managed')`, [PROJECT_ID, OWNER_ID, relativeRoot]);
  await dataSource.query(`INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
    VALUES ($1, $2, $2, $3, 'managed', $3, 'active')`, [OWNER_ID, PROJECT_ID, relativeRoot]);
  await dataSource.query('INSERT INTO "conversations" ("id", "owner_id", "project_id", "title") VALUES ($1, $2, $3, $4)',
    [CONVERSATION_ID, OWNER_ID, PROJECT_ID, 'Command cancellation fixture']);
}

async function reconcileOwner(dataSource: DataSource, quota: TypeOrmStorageQuotaRepository, accounting: TypeOrmStorageContentAccounting, roots: readonly TrustedStorageRoot[]): Promise<void> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    const refs = await accounting.scanDatabaseContent(runner, OWNER_ID);
    await runner.commitTransaction();
    const fileRefs = await new StorageQuotaRootScanner().scan(roots);
    await quota.reconcileReferences(OWNER_ID, [...refs, ...fileRefs]);
  } catch (error: unknown) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

async function storageSnapshot(dataSource: DataSource): Promise<{ readonly usage: UsageRow; readonly references: readonly ReferenceRow[] }> {
  const usage: readonly UsageRow[] = await dataSource.query(`SELECT "accounting_state", "used_bytes"::text AS "used_bytes", "reserved_bytes"::text AS "reserved_bytes"
    FROM "storage_account_totals" WHERE "owner_id" = $1`, [OWNER_ID]);
  const references: readonly ReferenceRow[] = await dataSource.query(`SELECT "resource_kind", "resource_key", "copy_key", "byte_count"::text AS "byte_count", "sha256"
    FROM "storage_resource_references" WHERE "owner_id" = $1 ORDER BY "resource_kind", "resource_key", "copy_key"`, [OWNER_ID]);
  if (!usage[0]) throw new Error('The command cancellation fixture has no ready storage total.');
  return { usage: usage[0], references };
}

function createManifest(): EgressManifest {
  const messages = [] as const;
  const request = 'Inspect the fixture README.';
  const source = 'fixture command target\n';
  const requestBytes = Buffer.byteLength(request, 'utf8');
  const fileBytes = Buffer.byteLength(source, 'utf8');
  const files = [{ relativePath: 'README.md', sourceHash: hash(source), sizeBytes: fileBytes }];
  return {
    manifestHash: hash(JSON.stringify({ files, model: MODEL })), provider: 'NVIDIA hosted NIM', providerProfile: PROVIDER_PROFILE, model: MODEL,
    categories: ['project_files'], files, facts: [], requestBytes, messageBytes: 0, messageCount: 0, messageHash: hash(JSON.stringify(messages)), messages,
    byteEstimate: requestBytes + fileBytes, tokenEstimate: 15, excludedItemCount: 0, omittedItemCount: 0, omissionSummary: '', bestEffortSecretDetection: true
  };
}

function commandResult(): CommandResult {
  return { exitCode: 0, termination: 'completed', durationMs: 12, outputBytes: 24, outputLineCount: 1, outputTruncated: false, outputSha256: hash('unexpected command output'), outputPreview: 'unexpected command output' };
}

function assertGuardedBaseUrl(connectionString: string): void {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !new Set(['127.0.0.1', 'localhost', '::1', '[::1]']).has(url.hostname)
    || url.port !== '55441' || url.pathname !== '/home_history_test' || url.username !== 'home_test') {
    throw new Error('HOME_CONVERSATION_TEST_DATABASE_URL must target the isolated home_test/home_history_test loopback fixture.');
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
