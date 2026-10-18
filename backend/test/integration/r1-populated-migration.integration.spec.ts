import type { DataSource } from 'typeorm';
import { DataSource as TypeOrmDataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmSessionRepository } from '@/infrastructure/database/repositories/typeorm-auth-repositories';
import { HomeProposalRollbackBlockedError } from '@/modules/home-assistant/domain/home-planning-errors';
import { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';

const OWNER_ID = '4a105f66-6666-4666-8666-666666666666';
const SESSION_ID = '4a105f66-6666-4666-8666-666666666667';
const LEGACY_SESSION_TOKEN = 'r1-preserved-legacy-session-token-0001';
const PROJECT_ID = '4a105f77-7777-4777-8777-777777777777';
const TASK_ID = '4a105f88-8888-4888-8888-888888888888';
const CONVERSATION_ID = '4a105f99-9999-4999-8999-999999999999';
const TURN_ID = '4a105faa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROPOSAL_ID = '4a105fbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROPOSAL_ITEM_ID = '4a105fcc-cccc-4ccc-8ccc-cccccccccccc';
const PROPOSAL_TARGET_ID = '4a105fdd-dddd-4ddd-8ddd-dddddddddddd';
const MIGRATION_DATABASE = 'home_history_task_5_1_migration_test';
const LEGACY_MIGRATION_COUNT = 18;
interface PgClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
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

describeDatabase('R1 populated database migration regression', () => {
  let migrationUrl: string;
  let dataSource: DataSource | undefined;
  let createdDatabase = false;
  let legacyTask: { readonly id: string; readonly title: string; readonly deadline: string | null; readonly importance: string; readonly subtasks: unknown };

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded migration base database URL is required.');
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{ readonly database: string; readonly user: string; readonly canCreateDatabase: boolean; readonly databaseExists: boolean }>(`
        SELECT current_database() AS "database", current_user AS "user",
          (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname" = current_user) AS "canCreateDatabase",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "databaseExists"
      `, [MIGRATION_DATABASE]);
      if (identity.rows[0]?.database !== 'home_history_test'
        || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.canCreateDatabase !== true) {
        throw new Error('The guarded task test role cannot create the separate migration database.');
      }
      if (identity.rows[0]!.databaseExists) {
        throw new Error('The fixed Task 5.1 migration database already exists; inspect ownership before retrying.');
      }
      await baseClient.query(`CREATE DATABASE "${MIGRATION_DATABASE}" OWNER "home_test"`);
      createdDatabase = true;
    } finally {
      await baseClient.end();
    }

    const target = new URL(databaseUrl);
    target.pathname = `/${MIGRATION_DATABASE}`;
    migrationUrl = target.toString();
    const configuredDataSource = createDataSource({ url: migrationUrl });
    const configuredMigrations = configuredDataSource.options.migrations;
    if (!Array.isArray(configuredMigrations) || configuredMigrations.length <= LEGACY_MIGRATION_COUNT) {
      throw new Error('The configured migration list does not contain the expected pre-Inbox baseline.');
    }
    const legacyDataSource = new TypeOrmDataSource({
      ...configuredDataSource.options,
      migrations: configuredMigrations.slice(0, LEGACY_MIGRATION_COUNT)
    });
    await legacyDataSource.initialize();
    try {
      const targetIdentity: readonly { readonly database: string; readonly user: string }[] = await legacyDataSource.query(
        'SELECT current_database() AS "database", current_user AS "user"'
      );
      expect(targetIdentity[0]).toEqual({ database: MIGRATION_DATABASE, user: 'home_test' });
      const existingRelations: readonly { readonly migrations: string | null; readonly projects: string | null; readonly projectTasks: string | null }[] = await legacyDataSource.query(`
        SELECT to_regclass('public.migrations')::text AS "migrations",
          to_regclass('public.projects')::text AS "projects",
          to_regclass('public.project_tasks')::text AS "projectTasks"
      `);
      expect(existingRelations[0]).toEqual({ migrations: null, projects: null, projectTasks: null });

      const legacyMigrations = await legacyDataSource.runMigrations({ transaction: 'all' });
      expect(legacyMigrations).toHaveLength(LEGACY_MIGRATION_COUNT);
      await seedLegacyProjectAndTask(legacyDataSource);
    } finally {
      await legacyDataSource.destroy();
    }

    dataSource = createDataSource({ url: migrationUrl });
    await dataSource.initialize();
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    expect(applied).toHaveLength(dataSource.migrations.length - LEGACY_MIGRATION_COUNT);
    const migrationRows: readonly { readonly name: string }[] = await dataSource.query('SELECT "name" FROM "migrations" ORDER BY "timestamp"');
    expect(migrationRows).toHaveLength(dataSource.migrations.length);
    expect(migrationRows.at(-1)?.name).toBe('AddAccountIdentity1710000026000');
    const migratedOwner: readonly { id: string; scope_key: string; display_name: string; identifier: string; account_kind: string; role: string; password_hash: string }[] = await dataSource.query(
      'SELECT "id", "scope_key", "display_name", "identifier", "account_kind", "role", "password_hash" FROM "users" WHERE "id" = $1',
      [OWNER_ID]
    );
    expect(migratedOwner[0]).toEqual({
      id: OWNER_ID,
      scope_key: 'local',
      display_name: 'R1 migration fixture owner',
      identifier: 'owner',
      account_kind: 'regular',
      role: 'admin',
      password_hash: 'x'
    });
    const retainedSession: readonly { readonly id: string; readonly user_id: string; readonly token_hash: string; readonly revoked_at: Date | null }[] = await dataSource.query(
      'SELECT "id", "user_id", "token_hash", "revoked_at" FROM "sessions" WHERE "id" = $1',
      [SESSION_ID]
    );
    expect(retainedSession).toEqual([{ id: SESSION_ID, user_id: OWNER_ID, token_hash: 'r1-migration-session-hash', revoked_at: null }]);
    const migratedSessionRepository = new TypeOrmSessionRepository(dataSource);
    await expect(migratedSessionRepository.findByTokenHash('r1-migration-session-hash')).resolves.toMatchObject({
      id: SESSION_ID,
      userId: OWNER_ID,
      accountKind: 'regular',
      role: 'admin',
      accountExpiresAt: null,
      revokedAt: null,
      expiresAt: new Date('2026-11-01T00:00:00.000Z')
    });
    const legacySessionUseCase = new GetSessionUseCase(
      migratedSessionRepository,
      {
        createToken: () => 'unused-session-token',
        digestToken: (token) => token === LEGACY_SESSION_TOKEN ? 'r1-migration-session-hash' : 'unknown-session-hash',
        createCsrfToken: (token) => `csrf:${token}`
      },
      { now: () => new Date('2026-10-19T12:00:00.000Z') }
    );
    await expect(legacySessionUseCase.execute(LEGACY_SESSION_TOKEN)).resolves.toMatchObject({
      principal: {
        id: OWNER_ID,
        displayName: 'R1 migration fixture owner',
        accountKind: 'regular',
        role: 'admin'
      },
      csrfToken: `csrf:${LEGACY_SESSION_TOKEN}`
    });
    const retainedTasks: readonly typeof legacyTask[] = await dataSource.query(
      'SELECT "id", "title", "deadline"::text AS "deadline", "importance", "subtasks" FROM "project_tasks" WHERE "id" = $1',
      [TASK_ID]
    );
    expect(retainedTasks).toHaveLength(1);
    legacyTask = retainedTasks[0]!;
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (!createdDatabase || !databaseUrl) return;
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      await baseClient.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [MIGRATION_DATABASE]);
      await baseClient.query(`DROP DATABASE "${MIGRATION_DATABASE}"`);
      createdDatabase = false;
    } finally {
      await baseClient.end();
    }
  }, 30_000);

  it('preserves the legacy owner and tasks, then verifies safe rollback of identity and proposal migrations', async () => {
    if (!dataSource) throw new Error('The isolated migration database was not initialized.');
    expect(legacyTask).toMatchObject({
      id: TASK_ID,
      title: 'R1 legacy task retained',
      deadline: '2026-10-20',
      importance: 'high',
      subtasks: [{ id: 'legacy-subtask', title: 'Keep checklist', completed: false }]
    });
    const tables: readonly { readonly inboxOrder: string | null; readonly homeEvents: string | null; readonly proposals: string | null }[] = await dataSource.query(`
      SELECT to_regclass('public.project_task_order_states')::text AS "inboxOrder",
        to_regclass('public.home_conversation_events')::text AS "homeEvents",
        to_regclass('public.home_change_proposals')::text AS "proposals"
    `);
    expect(tables[0]).toEqual({ inboxOrder: 'project_task_order_states', homeEvents: 'home_conversation_events', proposals: 'home_change_proposals' });

    await dataSource.undoLastMigration({ transaction: 'all' });
    const identityColumns: readonly { readonly identifier: string | null }[] = await dataSource.query(`
      SELECT column_name AS "identifier" FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'identifier'
    `);
    expect(identityColumns).toHaveLength(0);
    const latestAfterIdentityRollback: readonly { readonly name: string }[] = await dataSource.query('SELECT "name" FROM "migrations" ORDER BY "timestamp" DESC LIMIT 1');
    expect(latestAfterIdentityRollback[0]?.name).toBe('CreateHomeChangeProposals1710000025000');

    await seedProposalRollbackFixture(dataSource);
    await expect(dataSource.undoLastMigration({ transaction: 'all' })).rejects.toBeInstanceOf(HomeProposalRollbackBlockedError);
    const rollbackEvidence: readonly { readonly proposalCount: string; readonly proposalEventCount: string; readonly migrationPresent: boolean }[] = await dataSource.query(`
      SELECT (SELECT COUNT(*)::text FROM "home_change_proposals") AS "proposalCount",
        (SELECT COUNT(*)::text FROM "home_conversation_events" WHERE "event_type" LIKE 'proposal.%') AS "proposalEventCount",
        EXISTS (SELECT 1 FROM "migrations" WHERE "name" = 'CreateHomeChangeProposals1710000025000') AS "migrationPresent"
    `);
    expect(rollbackEvidence[0]).toEqual({ proposalCount: '1', proposalEventCount: '1', migrationPresent: true });

    await dataSource.query('DELETE FROM "home_conversations" WHERE "id" = $1', [CONVERSATION_ID]);
    await expect(dataSource.undoLastMigration({ transaction: 'all' })).resolves.toBeUndefined();
    const postRollback: readonly { readonly proposalTable: string | null; readonly retainedTaskCount: string; readonly projectCount: string }[] = await dataSource.query(`
      SELECT to_regclass('public.home_change_proposals')::text AS "proposalTable",
        (SELECT COUNT(*)::text FROM "project_tasks" WHERE "id" = $1) AS "retainedTaskCount",
        (SELECT COUNT(*)::text FROM "projects" WHERE "id" = $2) AS "projectCount"
    `, [TASK_ID, PROJECT_ID]);
    expect(postRollback[0]).toEqual({ proposalTable: null, retainedTaskCount: '1', projectCount: '1' });
  }, 120_000);
});

async function seedLegacyProjectAndTask(dataSource: DataSource): Promise<void> {
  await dataSource.query('INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash") VALUES ($1, $2, $3, $4)', [OWNER_ID, 'local', 'R1 migration fixture owner', 'x']);
  await dataSource.query(
    'INSERT INTO "sessions" ("id", "user_id", "token_hash", "expires_at") VALUES ($1, $2, $3, $4)',
    [SESSION_ID, OWNER_ID, 'r1-migration-session-hash', new Date('2026-11-01T00:00:00.000Z')]
  );
  await dataSource.query(`
    INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key")
    VALUES ($1, $2, 'R1 legacy project', 'r1-legacy-project', 'legacy-project', 'legacy-project')
  `, [PROJECT_ID, OWNER_ID]);
  await dataSource.query(`
    INSERT INTO "project_tasks" ("id", "owner_id", "project_id", "title", "details", "status", "position", "importance", "deadline", "subtasks")
    VALUES ($1, $2, $3, 'R1 legacy task retained', 'legacy details', 'todo', 0, 'high', '2026-10-20', $4::jsonb)
  `, [TASK_ID, OWNER_ID, PROJECT_ID, JSON.stringify([{ id: 'legacy-subtask', title: 'Keep checklist', completed: false }])]);
}

async function seedProposalRollbackFixture(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    INSERT INTO "home_conversations" ("id", "owner_id", "scope", "workspace_id", "title", "create_request_key", "create_request_fingerprint")
    VALUES ($1, $2, 'home', NULL, 'R1 migration proposal history', 'r1-migration-conversation', $3)
  `, [CONVERSATION_ID, OWNER_ID, 'a'.repeat(64)]);
  await dataSource.query(`
    INSERT INTO "home_turns" ("id", "owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint", "status")
    VALUES ($1, $2, $3, 1, 'r1-migration-turn', $4, 'completed')
  `, [TURN_ID, OWNER_ID, CONVERSATION_ID, 'b'.repeat(64)]);
  await dataSource.query(`
    INSERT INTO "home_change_proposals" ("id", "owner_id", "conversation_id", "source_turn_id", "scope_kind", "scope_id", "runtime_request_id", "request_fingerprint", "item_count", "command_bytes")
    VALUES ($1, $2, $3, $4, 'home', NULL, 'r1-migration-proposal', $5, 1, 64)
  `, [PROPOSAL_ID, OWNER_ID, CONVERSATION_ID, TURN_ID, 'c'.repeat(64)]);
  await dataSource.query(`
    INSERT INTO "home_change_proposal_items" ("id", "owner_id", "conversation_id", "proposal_id", "position", "action_kind", "target_kind", "target_id", "command")
    VALUES ($1, $2, $3, $4, 0, 'task.create', 'task', $5, $6::jsonb)
  `, [PROPOSAL_ITEM_ID, OWNER_ID, CONVERSATION_ID, PROPOSAL_ID, PROPOSAL_TARGET_ID, JSON.stringify({ action: 'task.create', title: 'R1 migration proposal item' })]);
  await dataSource.query(`
    INSERT INTO "home_conversation_events" ("owner_id", "conversation_id", "sequence", "event_type", "turn_id", "entity_id", "payload")
    VALUES ($1, $2, 1, 'proposal.created', $3, $4, $5::jsonb)
  `, [OWNER_ID, CONVERSATION_ID, TURN_ID, PROPOSAL_ID, JSON.stringify({ state: 'review_required', revision: 1, itemCount: 1 })]);
  await dataSource.query('UPDATE "home_conversations" SET "last_event_sequence" = 1 WHERE "id" = $1', [CONVERSATION_ID]);
}
