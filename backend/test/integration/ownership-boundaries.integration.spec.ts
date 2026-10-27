import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';

const OWNERSHIP_DATABASE = 'home_history_task_2_2_ownership_test';
const OWNER_ID = '2a200000-0000-4000-8000-000000000001';
const OTHER_OWNER_ID = '2a200000-0000-4000-8000-000000000002';
const OWNER_PROJECT_ID = '2a210000-0000-4000-8000-000000000001';
const OWNER_SECOND_PROJECT_ID = '2a210000-0000-4000-8000-000000000002';
const OTHER_OWNER_PROJECT_ID = '2a210000-0000-4000-8000-000000000003';
const OTHER_OWNER_CONVERSATION_ID = '2a220000-0000-4000-8000-000000000001';
const MISMATCHED_OWNER_CONVERSATION_ID = '2a220000-0000-4000-8000-000000000002';
const RUN_OWNER_CONVERSATION_ID = '2a220000-0000-4000-8000-000000000003';
const RUN_OTHER_PROJECT_CONVERSATION_ID = '2a220000-0000-4000-8000-000000000004';
const VALID_RUN_ID = '2a230000-0000-4000-8000-000000000001';
const MISMATCHED_RUN_ID = '2a230000-0000-4000-8000-000000000002';

interface PgClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
}

interface ProjectFixture {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly slug: string;
}

const { Client } = require('pg') as { readonly Client: new (options: { readonly connectionString: string }) => PgClient };
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

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

describeDatabase('Task 2.2 PostgreSQL ownership constraints', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded ownership integration database URL is required.');
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
      `, [OWNERSHIP_DATABASE]);
      if (identity.rows[0]?.database !== 'home_history_test'
        || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.canCreateDatabase !== true) {
        throw new Error('The guarded Task 2.2 test role cannot create its isolated database.');
      }
      if (identity.rows[0]?.databaseExists) {
        throw new Error('The fixed Task 2.2 ownership database already exists; inspect ownership before retrying.');
      }
      await baseClient.query(`CREATE DATABASE "${OWNERSHIP_DATABASE}" OWNER "home_test"`);
      databaseCreated = true;
    } finally {
      await baseClient.end();
    }

    const target = new URL(databaseUrl);
    target.pathname = `/${OWNERSHIP_DATABASE}`;
    dataSource = createDataSource({ url: target.toString() });
    await dataSource.initialize();
    const targetIdentity: readonly { readonly database: string; readonly user: string }[] = await dataSource.query(
      'SELECT current_database() AS "database", current_user AS "user"'
    );
    expect(targetIdentity).toEqual([{ database: OWNERSHIP_DATABASE, user: 'home_test' }]);

    const appliedMigrations = await dataSource.runMigrations({ transaction: 'all' });
    expect(appliedMigrations).toHaveLength(dataSource.migrations.length);
    const migrationNames: readonly { readonly name: string }[] = await dataSource.query(
      'SELECT "name" FROM "migrations" ORDER BY "timestamp"'
    );
    expect(migrationNames.map(({ name }) => name)).toContain('EnforceProjectOwnershipBoundaries1710000027000');
    await seedOwnershipFixtures(dataSource);
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
        readonly targetOwner: string | null;
        readonly databaseExists: boolean;
      }>(`
        SELECT current_database() AS "database", current_user AS "user",
          (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname" = $1) AS "targetOwner",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "databaseExists"
      `, [OWNERSHIP_DATABASE]);
      if (identity.rows[0]?.database !== 'home_history_test'
        || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.targetOwner !== 'home_test') {
        throw new Error('Refusing to drop the Task 2.2 database because the guarded base identity did not match.');
      }
      if (!identity.rows[0]?.databaseExists) {
        databaseCreated = false;
        return;
      }
      await baseClient.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [OWNERSHIP_DATABASE]
      );
      await baseClient.query(`DROP DATABASE "${OWNERSHIP_DATABASE}"`);
      databaseCreated = false;
    } finally {
      await baseClient.end();
    }
  }, 30_000);

  it('rejects a conversation whose owner and existing project belong to different accounts', async () => {
    if (!dataSource) throw new Error('The isolated ownership database was not initialized.');
    const validParentRows: readonly { readonly ownerCount: string; readonly projectCount: string; readonly projectOwner: string }[] = await dataSource.query(`
      SELECT (SELECT COUNT(*)::text FROM "users" WHERE "id" = $1) AS "ownerCount",
        (SELECT COUNT(*)::text FROM "projects" WHERE "id" = $2) AS "projectCount",
        (SELECT "owner_id"::text FROM "projects" WHERE "id" = $2) AS "projectOwner"
    `, [OWNER_ID, OTHER_OWNER_PROJECT_ID]);
    expect(validParentRows).toEqual([{ ownerCount: '1', projectCount: '1', projectOwner: OTHER_OWNER_ID }]);

    await insertConversation(dataSource, OTHER_OWNER_CONVERSATION_ID, OTHER_OWNER_ID, OTHER_OWNER_PROJECT_ID);
    const ownedControl: readonly { readonly owner_id: string; readonly project_id: string }[] = await dataSource.query(
      'SELECT "owner_id"::text, "project_id"::text FROM "conversations" WHERE "id" = $1',
      [OTHER_OWNER_CONVERSATION_ID]
    );
    expect(ownedControl).toEqual([{ owner_id: OTHER_OWNER_ID, project_id: OTHER_OWNER_PROJECT_ID }]);

    await expect(insertConversation(dataSource, MISMATCHED_OWNER_CONVERSATION_ID, OWNER_ID, OTHER_OWNER_PROJECT_ID))
      .rejects.toMatchObject({ driverError: { code: '23503', constraint: 'FK_conversations_project_owner' } });
  }, 30_000);

  it('rejects a same-owner AI run linked to a conversation from another project', async () => {
    if (!dataSource) throw new Error('The isolated ownership database was not initialized.');
    await insertConversation(dataSource, RUN_OWNER_CONVERSATION_ID, OWNER_ID, OWNER_PROJECT_ID);
    await insertConversation(dataSource, RUN_OTHER_PROJECT_CONVERSATION_ID, OWNER_ID, OWNER_SECOND_PROJECT_ID);

    await insertAiRun(dataSource, VALID_RUN_ID, OWNER_PROJECT_ID, RUN_OWNER_CONVERSATION_ID);
    const validRun: readonly { readonly owner_id: string; readonly project_id: string; readonly conversation_id: string }[] = await dataSource.query(
      'SELECT "owner_id"::text, "project_id"::text, "conversation_id"::text FROM "ai_runs" WHERE "id" = $1',
      [VALID_RUN_ID]
    );
    expect(validRun).toEqual([{ owner_id: OWNER_ID, project_id: OWNER_PROJECT_ID, conversation_id: RUN_OWNER_CONVERSATION_ID }]);

    await expect(insertAiRun(dataSource, MISMATCHED_RUN_ID, OWNER_PROJECT_ID, RUN_OTHER_PROJECT_CONVERSATION_ID))
      .rejects.toMatchObject({ driverError: { code: '23503', constraint: 'FK_ai_runs_conversation_scope' } });
  }, 30_000);
});

async function seedOwnershipFixtures(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    INSERT INTO "users" ("id", "scope_key", "identifier", "account_kind", "role", "display_name", "password_hash")
    VALUES ($1, 'local', 'owner', 'regular', 'admin', 'Task 2.2 owner fixture', 'test-owner-hash')
  `, [OWNER_ID]);
  await dataSource.query(`
    INSERT INTO "users" ("id", "scope_key", "identifier", "account_kind", "role", "display_name", "password_hash")
    VALUES ($1, 'account:task2-2-foreign', 'task2-2-foreign', 'regular', 'user', 'Task 2.2 second owner fixture', 'test-other-owner-hash')
  `, [OTHER_OWNER_ID]);

  const projects: readonly ProjectFixture[] = [
    { id: OWNER_PROJECT_ID, ownerId: OWNER_ID, name: 'Owner project', slug: 'owner-project' },
    { id: OWNER_SECOND_PROJECT_ID, ownerId: OWNER_ID, name: 'Owner second project', slug: 'owner-second-project' },
    { id: OTHER_OWNER_PROJECT_ID, ownerId: OTHER_OWNER_ID, name: 'Other owner project', slug: 'other-owner-project' }
  ];
  for (const project of projects) {
    const relativeRoot = `projects/${project.id}`;
    await dataSource.query(`
      INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind")
      VALUES ($1, $2, $3, $4, $5, $5, 'managed')
    `, [project.id, project.ownerId, project.name, project.slug, relativeRoot]);
  }
}

async function insertConversation(dataSource: DataSource, conversationId: string, ownerId: string, projectId: string): Promise<void> {
  await dataSource.query(
    'INSERT INTO "conversations" ("id", "owner_id", "project_id", "title") VALUES ($1, $2, $3, $4)',
    [conversationId, ownerId, projectId, 'Task 2.2 ownership fixture conversation']
  );
}

async function insertAiRun(dataSource: DataSource, runId: string, projectId: string, conversationId: string): Promise<void> {
  await dataSource.query(`
    INSERT INTO "ai_runs" (
      "id", "owner_id", "project_id", "conversation_id", "request", "relative_root",
      "manifest", "manifest_hash", "create_idempotency_key", "request_fingerprint", "safe_message", "storage_kind"
    ) VALUES ($1, $2, $3, $4, 'Task 2.2 ownership fixture request', $5, '{}'::jsonb, $6, $7, $8, 'Test fixture only', 'managed')
  `, [runId, OWNER_ID, projectId, conversationId, `projects/${projectId}`, 'a'.repeat(64), `create-${runId}`, 'b'.repeat(64)]);
}
