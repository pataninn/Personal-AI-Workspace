import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmActionLedgerRepository } from '@/infrastructure/database/repositories/typeorm-action-ledger-repository';
import { TypeOrmProjectTaskRepository } from '@/infrastructure/database/repositories/typeorm-project-task-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { TaskMutationUseCases } from '@/modules/tasks/use-cases/task-mutation-use-cases';

const DATABASE_NAME = 'home_history_task_3_2_task_test';
const OWNER_ID = '3a320000-0000-4000-8000-000000000501';
const PROJECT_ID = '3a320000-0000-4000-8000-000000000502';
const CONVERSATION_ID = '3a320000-0000-4000-8000-000000000503';
const RUN_ID = '3a320000-0000-4000-8000-000000000504';
const SUGGESTION_ID = '3a320000-0000-4000-8000-000000000505';
const SUBTASK_ID = '3a320000-0000-4000-8000-000000000506';
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

interface PgClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
}

interface ReferenceRow {
  readonly resource_key: string;
  readonly copy_key: string;
  readonly byte_count: string;
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

describeDatabase('Project task storage quota PostgreSQL integration', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let taskRepository: TypeOrmProjectTaskRepository;
  let quotaRepository: TypeOrmStorageQuotaRepository;
  let accounting: TypeOrmStorageContentAccounting;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded project task quota database URL is required.');
    await createIsolatedDatabase();
    databaseCreated = true;
    const target = new URL(databaseUrl);
    target.pathname = `/${DATABASE_NAME}`;
    dataSource = createDataSource({ url: target.toString() });
    await dataSource.initialize();
    const identity: readonly { readonly database: string; readonly user: string }[] = await dataSource.query(
      'SELECT current_database() AS "database", current_user AS "user"'
    );
    expect(identity).toEqual([{ database: DATABASE_NAME, user: 'home_test' }]);
    const migrations = await dataSource.runMigrations({ transaction: 'all' });
    expect(migrations).toHaveLength(dataSource.migrations.length);

    await seedTaskContent(dataSource);
    quotaRepository = new TypeOrmStorageQuotaRepository(dataSource);
    accounting = new TypeOrmStorageContentAccounting(dataSource, quotaRepository);
    taskRepository = new TypeOrmProjectTaskRepository(dataSource, accounting);
    await reconcileOwner(dataSource, quotaRepository, accounting);
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (!databaseCreated || !databaseUrl) return;
    await dropIsolatedDatabase();
    databaseCreated = false;
  }, 30_000);

  it('accounts project, suggestion, task snapshots, and action receipts; rolls back denied growth and permits shrink while over limit', async () => {
    const source = requiredDataSource();
    const baseline = await quotaRepository.readUsage(OWNER_ID);
    expect(baseline.state).toBe('ready');
    if (baseline.usedBytes === null) throw new Error('The seeded inventory must have verified byte totals.');
    const baselineBytes = baseline.usedBytes;
    const baselineReferences = await canonicalReferences(source, accounting, OWNER_ID);
    expect(baselineBytes).toBe(referenceTotal(baselineReferences));
    await expect(readEntityReferences(source, OWNER_ID, `projects:${PROJECT_ID}`)).resolves.toEqual([
      { resource_key: `projects:${PROJECT_ID}`, copy_key: 'name', byte_count: String(Buffer.byteLength('Project \u96ea', 'utf8')) },
      { resource_key: `projects:${PROJECT_ID}`, copy_key: 'objective', byte_count: String(Buffer.byteLength('Objective \u00e9', 'utf8')) }
    ]);
    const suggestionBytes = await readEntityReferences(source, OWNER_ID, `project_task_suggestions:${SUGGESTION_ID}`);
    expect(suggestionBytes.map(({ copy_key }) => copy_key)).toEqual(['details', 'subtasks', 'title']);
    await expect(readReferences(source, OWNER_ID)).resolves.toEqual(await canonicalReferences(source, accounting, OWNER_ID));

    const accepted = await taskRepository.resolveSuggestion({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      suggestionId: SUGGESTION_ID,
      expectedVersion: 1,
      decision: 'accepted',
      title: 'Accepted task \u96ea',
      details: 'Accepted detail \u00e9',
      importance: 'high',
      deadline: null,
      subtasks: [{ id: '3a320000-0000-4000-8000-000000000507', title: 'Accepted step \u96ea', completed: false }]
    });
    if (accepted.decision !== 'accepted') throw new Error('Accepting the seeded suggestion must create a task.');
    const afterSuggestion = await quotaRepository.readUsage(OWNER_ID);
    expect(afterSuggestion.usedBytes).toBeGreaterThan(baselineBytes);
    const afterSuggestionReferences = await canonicalReferences(source, accounting, OWNER_ID);
    expect(afterSuggestion.usedBytes).toBe(referenceTotal(afterSuggestionReferences));
    await expect(readReferences(source, OWNER_ID)).resolves.toEqual(afterSuggestionReferences);
    const acceptedTaskCopies = await readEntityReferences(source, OWNER_ID, `project_tasks:${accepted.task.id}`);
    expect(acceptedTaskCopies.map(({ copy_key }) => copy_key)).toEqual(['details', 'subtasks', 'title']);
    expect(acceptedTaskCopies.find(({ copy_key }) => copy_key === 'details')?.byte_count).toBe(String(Buffer.byteLength('Accepted detail \u00e9', 'utf8')));
    expect(acceptedTaskCopies.find(({ copy_key }) => copy_key === 'title')?.byte_count).toBe(String(Buffer.byteLength('Accepted task \u96ea', 'utf8')));
    const acceptedTaskSizes = await readTaskContentSizes(source, accepted.task.id);
    expect(acceptedTaskCopies.find(({ copy_key }) => copy_key === 'subtasks')?.byte_count).toBe(acceptedTaskSizes.subtasks_bytes);

    const createInput = {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      title: 'Checklist \u96ea',
      details: 'Initial details \u00e9',
      idempotencyKey: 'task-storage-create-once',
      requestFingerprint: 'task-storage-create-fingerprint',
      importance: 'medium' as const,
      deadline: null,
      subtasks: [{ id: SUBTASK_ID, title: 'Review \u96ea', completed: false }]
    };
    const created = await taskRepository.createTask(createInput);
    expect(created.replayed).toBe(false);
    const replay = await taskRepository.createTask(createInput);
    expect(replay).toMatchObject({ replayed: true, task: { id: created.task.id } });
    const taskCopies = await readEntityReferences(source, OWNER_ID, `project_tasks:${created.task.id}`);
    expect(taskCopies.map(({ copy_key }) => copy_key)).toEqual(['details', 'idempotency_snapshot', 'subtasks', 'title']);
    expect(taskCopies.find(({ copy_key }) => copy_key === 'title')?.byte_count).toBe(String(Buffer.byteLength(createInput.title, 'utf8')));
    expect(taskCopies.find(({ copy_key }) => copy_key === 'details')?.byte_count).toBe(String(Buffer.byteLength(createInput.details, 'utf8')));
    const taskSizes = await readTaskContentSizes(source, created.task.id);
    expect(taskCopies.find(({ copy_key }) => copy_key === 'subtasks')?.byte_count).toBe(taskSizes.subtasks_bytes);
    expect(taskCopies.find(({ copy_key }) => copy_key === 'idempotency_snapshot')?.byte_count).toBe(taskSizes.snapshot_bytes);
    const afterCreateUsage = await quotaRepository.readUsage(OWNER_ID);
    if (afterCreateUsage.usedBytes === null) throw new Error('Task creation must preserve ready quota state.');
    const afterCreateReferences = await canonicalReferences(source, accounting, OWNER_ID);
    expect(afterCreateUsage.usedBytes).toBe(referenceTotal(afterCreateReferences));
    expect(await readReferences(source, OWNER_ID)).toEqual(afterCreateReferences);
    const beforeLedger = await quotaRepository.readUsage(OWNER_ID);
    if (beforeLedger.usedBytes === null) throw new Error('Task creation must preserve ready quota state.');

    const actionLedger = new TypeOrmActionLedgerRepository(source, undefined, accounting);
    const mutations = new TaskMutationUseCases(actionLedger, taskRepository, taskRepository);
    const updateInput = {
      ownerId: OWNER_ID,
      taskId: created.task.id,
      expectedProjectId: PROJECT_ID,
      expectedVersion: created.task.version,
      operationKey: 'task-storage-update-once',
      title: 'Checklist updated \u96ea',
      details: 'Updated detail \u00e9'
    };
    const updated = await mutations.update(updateInput);
    expect(updated.replayed).toBe(false);
    const updatedUsage = await quotaRepository.readUsage(OWNER_ID);
    if (updatedUsage.usedBytes === null) throw new Error('Task ledger mutation must preserve ready quota state.');
    const receiptCopies = await readEntityReferences(source, OWNER_ID, `action_ledger_records:${updated.receipt.id}`);
    expect(receiptCopies.map(({ copy_key }) => copy_key)).toEqual(['outcome', 'reversible_fields']);
    const receipt = await readReceiptCopies(source, updated.receipt.id);
    expect(receiptCopies.find(({ copy_key }) => copy_key === 'outcome')?.byte_count).toBe(receipt.outcome_bytes);
    expect(receiptCopies.find(({ copy_key }) => copy_key === 'reversible_fields')?.byte_count).toBe(receipt.reversible_bytes);
    expect(receipt.request_fingerprint_bytes).toBe(String(Buffer.byteLength(updated.receipt.requestFingerprint, 'utf8')));
    expect(receiptCopies.some(({ copy_key }) => copy_key === 'request_fingerprint')).toBe(false);
    const replayedUpdate = await mutations.update(updateInput);
    expect(replayedUpdate).toMatchObject({ replayed: true, receipt: { id: updated.receipt.id } });
    await expect(quotaRepository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: updatedUsage.usedBytes });
    const afterUpdateReferences = await canonicalReferences(source, accounting, OWNER_ID);
    expect(updatedUsage.usedBytes).toBe(referenceTotal(afterUpdateReferences));
    await expect(readReferences(source, OWNER_ID)).resolves.toEqual(afterUpdateReferences);

    const beforeDenied = await quotaRepository.readUsage(OWNER_ID);
    if (beforeDenied.usedBytes === null) throw new Error('The denial check requires verified usage.');
    await setStorageLimit(source, beforeDenied.usedBytes);
    const deniedRefs = await readReferences(source, OWNER_ID);
    const deniedCounts = await readWriteCounts(source);
    await expect(mutations.update({
      ownerId: OWNER_ID,
      taskId: created.task.id,
      expectedProjectId: PROJECT_ID,
      expectedVersion: updated.item.task.version,
      operationKey: 'task-storage-update-denied',
      title: 'A deliberately much longer task title for quota denial'
    })).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED', statusCode: 413 });
    await expect(readWriteCounts(source)).resolves.toEqual(deniedCounts);
    await expect(readReferences(source, OWNER_ID)).resolves.toEqual(deniedRefs);
    await expect(quotaRepository.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: beforeDenied.usedBytes });
    const afterDeniedTask: readonly { readonly title: string; readonly version: number }[] = await source.query(
      'SELECT "title", "version" FROM "project_tasks" WHERE "owner_id" = $1 AND "id" = $2', [OWNER_ID, created.task.id]
    );
    expect(afterDeniedTask).toEqual([{ title: updateInput.title, version: updated.item.task.version }]);

    await setStorageLimit(source, baselineBytes);
    const beforeShrink = await quotaRepository.readUsage(OWNER_ID);
    if (beforeShrink.usedBytes === null) throw new Error('The shrink check requires verified usage.');
    expect(beforeShrink.overLimit).toBe(true);
    const shrunk = await taskRepository.updateTask({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      taskId: created.task.id,
      expectedVersion: updated.item.task.version,
      text: { title: 'x', details: '', subtasks: [] }
    });
    expect(shrunk.task).toMatchObject({ title: 'x', details: '', subtasks: [], version: updated.item.task.version + 1 });
    const afterShrink = await quotaRepository.readUsage(OWNER_ID);
    expect(afterShrink.usedBytes).toBeLessThan(beforeShrink.usedBytes);
    expect(afterShrink.overLimit).toBe(true);
    expect(afterShrink.usedBytes).toBeGreaterThan(baselineBytes);
    const afterShrinkReferences = await canonicalReferences(source, accounting, OWNER_ID);
    expect(afterShrink.usedBytes).toBe(referenceTotal(afterShrinkReferences));
    await expect(readReferences(source, OWNER_ID)).resolves.toEqual(afterShrinkReferences);
    await expect(readEntityReferences(source, OWNER_ID, `project_tasks:${created.task.id}`)).resolves.toContainEqual({
      resource_key: `project_tasks:${created.task.id}`, copy_key: 'idempotency_snapshot',
      byte_count: taskCopies.find(({ copy_key }) => copy_key === 'idempotency_snapshot')?.byte_count
    });
    const eventContentReferences = await source.query(
      `SELECT "resource_key" FROM "storage_resource_references" WHERE "owner_id" = $1 AND "resource_key" LIKE 'project_task_events:%'`, [OWNER_ID]
    ) as readonly { readonly resource_key: string }[];
    expect(eventContentReferences).toEqual([]);
  });

  function requiredDataSource(): DataSource {
    if (!dataSource) throw new Error('The isolated project task quota database was not initialized.');
    return dataSource;
  }
});

async function createIsolatedDatabase(): Promise<void> {
  await withBaseClient(async (client) => {
    const identity = await client.query<{ readonly database: string; readonly user: string; readonly canCreateDatabase: boolean; readonly databaseExists: boolean }>(`SELECT current_database() AS "database", current_user AS "user",
      (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname" = current_user) AS "canCreateDatabase",
      EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "databaseExists"`, [DATABASE_NAME]);
    if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
      || identity.rows[0]?.canCreateDatabase !== true) {
      throw new Error('The guarded role cannot create the isolated project task quota database.');
    }
    if (identity.rows[0]?.databaseExists) throw new Error('The project task quota database exists; inspect ownership before retrying.');
    await client.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "home_test"`);
  });
}

async function dropIsolatedDatabase(): Promise<void> {
  await withBaseClient(async (client) => {
    const identity = await client.query<{ readonly database: string; readonly user: string; readonly owner: string | null; readonly exists: boolean }>(`SELECT current_database() AS "database", current_user AS "user",
      (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname" = $1) AS "owner",
      EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "exists"`, [DATABASE_NAME]);
    if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
      || identity.rows[0]?.owner !== 'home_test') {
      throw new Error('Refusing to remove the project task quota database because its guarded identity changed.');
    }
    if (!identity.rows[0]?.exists) return;
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [DATABASE_NAME]);
    await client.query(`DROP DATABASE "${DATABASE_NAME}"`);
  });
}

async function withBaseClient<T>(operation: (client: PgClient) => Promise<T>): Promise<T> {
  if (!databaseUrl) throw new Error('The guarded project task quota database URL is required.');
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function seedTaskContent(dataSource: DataSource): Promise<void> {
  await dataSource.query(`INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash", "identifier", "account_kind", "role", "expires_at")
    VALUES ($1, 'local', 'Task quota fixture', 'fixture-hash', 'owner', 'regular', 'admin', NULL)`, [OWNER_ID]);
  await dataSource.query('INSERT INTO "account_limits" ("owner_id", "storage_limit_bytes") VALUES ($1, 1000000)', [OWNER_ID]);
  await dataSource.query(`INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "objective", "storage_kind")
    VALUES ($1, $2, 'Project \u96ea', 'task-quota-fixture', 'legacy/task-quota-fixture', 'legacy/task-quota-fixture', 'Objective \u00e9', 'legacy')`, [PROJECT_ID, OWNER_ID]);
  await dataSource.query(`INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
    VALUES ($1, $2, $2, 'legacy/task-quota-fixture', 'legacy', 'legacy/task-quota-fixture', 'active')`, [OWNER_ID, PROJECT_ID]);
  await dataSource.query('INSERT INTO "conversations" ("id", "owner_id", "project_id", "title") VALUES ($1, $2, $3, $4)', [CONVERSATION_ID, OWNER_ID, PROJECT_ID, 'Suggestion source']);
  await dataSource.query(`INSERT INTO "ai_runs" ("id", "owner_id", "project_id", "conversation_id", "request", "relative_root", "requested_paths", "manifest", "manifest_hash", "storage_kind", "create_idempotency_key", "request_fingerprint", "safe_message")
    VALUES ($1, $2, $3, $4, 'task suggestion fixture', 'legacy/task-quota-fixture', '[]'::jsonb, '{}'::jsonb, 'fixture-hash', 'legacy', 'task-suggestion-run', 'fixture-fingerprint', 'Fixture only')`, [RUN_ID, OWNER_ID, PROJECT_ID, CONVERSATION_ID]);
  await dataSource.query(`INSERT INTO "project_task_suggestions" ("id", "owner_id", "project_id", "run_id", "conversation_id", "ordinal", "title", "details", "subtasks")
    VALUES ($1, $2, $3, $4, $5, 0, 'Suggested task', 'Suggested detail', '[{"title":"Suggested subtask"}]'::jsonb)`, [SUGGESTION_ID, OWNER_ID, PROJECT_ID, RUN_ID, CONVERSATION_ID]);
}

async function reconcileOwner(dataSource: DataSource, quota: TypeOrmStorageQuotaRepository, accounting: TypeOrmStorageContentAccounting): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    await queryRunner.startTransaction();
    const refs = await accounting.scanDatabaseContent(queryRunner, OWNER_ID);
    await queryRunner.commitTransaction();
    await quota.reconcileReferences(OWNER_ID, refs);
  } catch (error: unknown) {
    if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function canonicalReferences(dataSource: DataSource, accounting: TypeOrmStorageContentAccounting, ownerId: string): Promise<readonly ReferenceRow[]> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    await queryRunner.startTransaction();
    const refs = await accounting.scanDatabaseContent(queryRunner, ownerId);
    await queryRunner.commitTransaction();
    return sortReferences(refs.map((ref) => ({ resource_key: ref.resourceKey, copy_key: ref.copyKey, byte_count: ref.bytes.toString() })));
  } catch (error: unknown) {
    if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function readReferences(dataSource: DataSource, ownerId: string): Promise<readonly ReferenceRow[]> {
  return await dataSource.query(`SELECT "resource_key", "copy_key", "byte_count"::text AS "byte_count"
    FROM "storage_resource_references" WHERE "owner_id" = $1 AND "resource_kind" = 'database_content'
    ORDER BY "resource_key", "copy_key"`, [ownerId]);
}

async function readEntityReferences(dataSource: DataSource, ownerId: string, resourceKey: string): Promise<readonly ReferenceRow[]> {
  return await dataSource.query(`SELECT "resource_key", "copy_key", "byte_count"::text AS "byte_count"
    FROM "storage_resource_references" WHERE "owner_id" = $1 AND "resource_kind" = 'database_content' AND "resource_key" = $2
    ORDER BY "copy_key"`, [ownerId, resourceKey]);
}

async function readReceiptCopies(dataSource: DataSource, receiptId: string): Promise<{ readonly reversible_bytes: string; readonly outcome_bytes: string; readonly request_fingerprint_bytes: string }> {
  const rows: readonly { readonly reversible_bytes: string; readonly outcome_bytes: string; readonly request_fingerprint_bytes: string }[] = await dataSource.query(`SELECT octet_length("reversible_fields"::text)::text AS "reversible_bytes",
    octet_length("outcome"::text)::text AS "outcome_bytes", octet_length("request_fingerprint")::text AS "request_fingerprint_bytes"
    FROM "action_ledger_records" WHERE "id" = $1`, [receiptId]);
  if (!rows[0]) throw new Error('The persisted task action receipt was not found.');
  return rows[0];
}

async function readTaskContentSizes(dataSource: DataSource, taskId: string): Promise<{ readonly subtasks_bytes: string; readonly snapshot_bytes: string | null }> {
  const rows: readonly { readonly subtasks_bytes: string; readonly snapshot_bytes: string | null }[] = await dataSource.query(`SELECT
    octet_length("subtasks"::text)::text AS "subtasks_bytes", octet_length("idempotency_snapshot"::text)::text AS "snapshot_bytes"
    FROM "project_tasks" WHERE "id" = $1`, [taskId]);
  if (!rows[0]) throw new Error('The persisted task content sizes were not found.');
  return rows[0];
}

async function readWriteCounts(dataSource: DataSource): Promise<{ readonly tasks: string; readonly events: string; readonly receipts: string }> {
  const rows: readonly { readonly tasks: string; readonly events: string; readonly receipts: string }[] = await dataSource.query(`SELECT
    (SELECT count(*)::text FROM "project_tasks" WHERE "owner_id" = $1) AS "tasks",
    (SELECT count(*)::text FROM "project_task_events" WHERE "owner_id" = $1) AS "events",
    (SELECT count(*)::text FROM "action_ledger_records" WHERE "owner_id" = $1) AS "receipts"`, [OWNER_ID]);
  if (!rows[0]) throw new Error('The task write counts query returned no row.');
  return rows[0];
}

async function setStorageLimit(dataSource: DataSource, limit: bigint): Promise<void> {
  await dataSource.query('UPDATE "account_limits" SET "storage_limit_bytes" = $2 WHERE "owner_id" = $1', [OWNER_ID, limit.toString()]);
}

function sortReferences(refs: readonly ReferenceRow[]): readonly ReferenceRow[] {
  return [...refs].sort((left, right) => `${left.resource_key}/${left.copy_key}`.localeCompare(`${right.resource_key}/${right.copy_key}`));
}

function referenceTotal(refs: readonly ReferenceRow[]): bigint {
  return refs.reduce((total, ref) => total + BigInt(ref.byte_count), 0n);
}
