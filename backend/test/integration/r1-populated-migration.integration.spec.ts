import type { DataSource } from 'typeorm';
import { DataSource as TypeOrmDataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmSessionRepository, TypeOrmUserRepository } from '@/infrastructure/database/repositories/typeorm-auth-repositories';
import { TypeOrmAiRunRepository } from '@/infrastructure/database/repositories/typeorm-ai-run-repository';
import { TypeOrmConversationRepository } from '@/infrastructure/database/repositories/typeorm-conversation-repository';
import { TypeOrmProjectRepository } from '@/infrastructure/database/repositories/typeorm-project-repository';
import { TypeOrmTaskSuggestionRepository } from '@/infrastructure/database/repositories/task-suggestion-completion-writer';
import { InMemoryRunEventPublisher } from '@/infrastructure/ai-runs/in-memory-run-event-publisher';
import { HomeProposalRollbackBlockedError } from '@/modules/home-assistant/domain/home-planning-errors';
import { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { PrincipalAuthorization } from '@/modules/auth/use-cases/principal-authorization';
import { StartAiRunUseCase } from '@/modules/ai-runs/use-cases/start-ai-run-use-case';
import type { AiRun, EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { IAgentRuntime, RuntimeInferenceEvent } from '@/modules/ai-runs/repositories/agent-runtime';

const OWNER_ID = '4a105f66-6666-4666-8666-666666666666';
const OTHER_USER_ID = '4a105f66-6666-4666-8666-666666666668';
const SESSION_ID = '4a105f66-6666-4666-8666-666666666667';
const EXPIRING_DEMO_ID = '4a105f66-6666-4666-8666-666666666669';
const LEGACY_SESSION_TOKEN = 'r1-preserved-legacy-session-token-0001';
const PROJECT_ID = '4a105f77-7777-4777-8777-777777777777';
const TASK_ID = '4a105f88-8888-4888-8888-888888888888';
const CONVERSATION_ID = '4a105f99-9999-4999-8999-999999999999';
const TURN_ID = '4a105faa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROPOSAL_ID = '4a105fbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROPOSAL_ITEM_ID = '4a105fcc-cccc-4ccc-8ccc-cccccccccccc';
const PROPOSAL_TARGET_ID = '4a105fdd-dddd-4ddd-8ddd-dddddddddddd';
const COMPLETION_CONVERSATION_ID = '4a105fee-eeee-4eee-8eee-eeeeeeeeeeee';
const EXPIRY_CONVERSATION_ID = '4a105ff0-eeee-4eee-8eee-eeeeeeeeeeee';
const EXPIRY_PROJECT_ID = '4a105f77-7777-4777-8777-777777777778';
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
  let migrationsFromOwnershipBoundary = 0;
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
    const ownershipBoundaryIndex = migrationRows.findIndex((migration) => migration.name === 'EnforceProjectOwnershipBoundaries1710000027000');
    expect(ownershipBoundaryIndex).toBeGreaterThanOrEqual(0);
    migrationsFromOwnershipBoundary = migrationRows.length - ownershipBoundaryIndex;
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

  it('keeps legacy storage bound to the immutable local account when its login identifier changes', async () => {
    if (!dataSource) throw new Error('The isolated migration database was not initialized.');
    const users = new TypeOrmUserRepository(dataSource);
    const originalOwnerId = await users.findBootstrapOwnerId();
    expect(originalOwnerId).toBe(OWNER_ID);

    await dataSource.query('UPDATE "users" SET "identifier" = $1 WHERE "id" = $2', ['renamed-legacy-owner', OWNER_ID]);
    expect(await users.findByIdentifier('owner')).toBeNull();
    expect(await users.findBootstrapOwnerId()).toBe(OWNER_ID);
    const legacyProject: readonly { readonly owner_id: string; readonly relative_root: string; readonly storage_kind: string }[] = await dataSource.query(
      'SELECT "owner_id", "relative_root", "storage_kind" FROM "projects" WHERE "id" = $1',
      [PROJECT_ID]
    );
    expect(legacyProject).toEqual([{ owner_id: OWNER_ID, relative_root: 'legacy-project', storage_kind: 'legacy' }]);

    await expect(dataSource.query('UPDATE "users" SET "scope_key" = $1 WHERE "id" = $2', ['account:renamed-local-scope', OWNER_ID]))
      .rejects.toThrow('the bootstrap owner scope is immutable');
    await expect(dataSource.query('UPDATE "users" SET "scope_key" = \'local\' WHERE "id" = $1', [OTHER_USER_ID]))
      .rejects.toThrow('the bootstrap owner scope is immutable');
    await expect(dataSource.query('DELETE FROM "users" WHERE "id" = $1', [OWNER_ID]))
      .rejects.toThrow('the bootstrap owner scope is immutable');
  }, 30_000);

  it('serializes run output against account disable and suppresses output after expiry wins', async () => {
    if (!dataSource) throw new Error('The isolated migration database was not initialized.');
    const users = new TypeOrmUserRepository(dataSource);
    await dataSource.query('UPDATE "users" SET "role" = \'admin\', "is_active" = true, "expires_at" = NULL WHERE "id" = $1', [OTHER_USER_ID]);
    await dataSource.query('UPDATE "users" SET "is_active" = true, "expires_at" = NULL WHERE "id" = $1', [OWNER_ID]);
    try {
    await dataSource.query(`
      INSERT INTO "users" ("id", "scope_key", "display_name", "identifier", "account_kind", "role", "password_hash", "is_active", "expires_at")
      VALUES ($1, 'account:expiring-demo', 'Expiring demo', NULL, 'demo', 'user', NULL, true, now() + interval '1 day')
    `, [EXPIRING_DEMO_ID]);
    await dataSource.query(`
      INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind")
      VALUES ($1, $2, 'Expiring demo project', 'expiring-demo-project', $3, $3, 'managed')
    `, [EXPIRY_PROJECT_ID, EXPIRING_DEMO_ID, `projects/${EXPIRY_PROJECT_ID}`]);

    const baseWriter = new TypeOrmTaskSuggestionRepository(dataSource);
    let enteredWriter!: () => void;
    let releaseWriter!: () => void;
    const writerEntered = new Promise<void>((resolve) => { enteredWriter = resolve; });
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const gatedWriter = {
      persistForRunCompletion: async (...args: Parameters<TypeOrmTaskSuggestionRepository['persistForRunCompletion']>) => {
        enteredWriter();
        await writerGate;
        return baseWriter.persistForRunCompletion(...args);
      }
    };
    const runs = new TypeOrmAiRunRepository(dataSource, gatedWriter);
    const conversations = new TypeOrmConversationRepository(dataSource);
    const completionRunId = await createReadyRun(dataSource, runs, COMPLETION_CONVERSATION_ID, 'running');

    const completion = runs.completeRun({
      ownerId: OWNER_ID, runId: completionRunId, status: 'succeeded', safeMessage: 'Assistant response complete.',
      assistantText: 'Permitted response before disable.', assistantComplete: true, cleanup: 'complete',
      providerTransmission: 'transmitted_confirmed', taskSuggestions: [{ title: 'Permitted suggestion', details: null }]
    });
    let disabled: Promise<'disabled' | 'not-found' | 'forbidden' | 'last-active-admin'> | undefined;
    try {
      await writerEntered;
      disabled = users.disableAccount(OTHER_USER_ID, OWNER_ID);
      await waitForBlockedAccountLock(dataSource);
    } finally {
      releaseWriter();
    }
    const [completedRun, disableResult] = await Promise.all([completion, disabled]);
    expect(completedRun?.status).toBe('succeeded');
    expect(disableResult).toBe('disabled');
    await expect(dataSource.query('SELECT "content" FROM "messages" WHERE "conversation_id" = $1 AND "role" = \'assistant\'', [COMPLETION_CONVERSATION_ID]))
      .resolves.toEqual([{ content: 'Permitted response before disable.' }]);
    await expect(dataSource.query('SELECT "title" FROM "project_task_suggestions" WHERE "run_id" = $1', [completionRunId]))
      .resolves.toEqual([{ title: 'Permitted suggestion' }]);

    await dataSource.query('UPDATE "users" SET "is_active" = true, "expires_at" = NULL WHERE "id" = $1', [OWNER_ID]);
    const expiryRuns = new TypeOrmAiRunRepository(dataSource);
    const expiryRunId = await createReadyRun(dataSource, expiryRuns, EXPIRY_CONVERSATION_ID, 'ready', EXPIRING_DEMO_ID, EXPIRY_PROJECT_ID, 'managed');
    let runtimeStarted!: () => void;
    let releaseRuntime!: () => void;
    const runtimeReady = new Promise<void>((resolve) => { runtimeStarted = resolve; });
    const runtimeGate = new Promise<void>((resolve) => { releaseRuntime = resolve; });
    const runtimeEvents: RuntimeInferenceEvent[] = [
      { type: 'tool.proposed', proposal: { runId: expiryRunId, commandId: 'late-command', command: 'write private file', args: [], cwd: '.' } },
      { type: 'assistant.delta', text: 'private content after expiry' },
      { type: 'completed', text: 'private content after expiry', taskSuggestions: [{ title: 'Expired suggestion', details: null }] }
    ];
    const runtime: IAgentRuntime = {
      checkAvailability: async () => undefined,
      create: async () => ({ kind: 'fake', sandboxReady: true }),
      startRun: async function* (): AsyncIterable<RuntimeInferenceEvent> {
        runtimeStarted();
        await runtimeGate;
        yield* runtimeEvents;
      },
      destroy: async () => undefined
    };
    const eventPublisher = new InMemoryRunEventPublisher();
    const seenEvents: string[] = [];
    let finishExpiredRun!: () => void;
    const expiredRunFinished = new Promise<void>((resolve) => { finishExpiredRun = resolve; });
    const unsubscribe = eventPublisher.subscribe(expiryRunId, (event) => {
      seenEvents.push(event.type);
      if (event.type === 'run.cancelled') finishExpiredRun();
    });
    const commandProposals = { execute: jest.fn().mockResolvedValue({ resource: { id: 'unused', status: 'pending_approval', safeMessage: 'Review command.' }, replayed: false }) };
    const principalAuthorization = new PrincipalAuthorization(users, { now: () => new Date() });
    const start = new StartAiRunUseCase(
      expiryRuns, conversations, runtime, eventPublisher, commandProposals, new TypeOrmProjectRepository(dataSource),
      undefined, undefined, undefined, principalAuthorization
    );

    try {
      await start.execute({ ownerId: EXPIRING_DEMO_ID, runId: expiryRunId, idempotencyKey: 'expiry-race-start' });
      await runtimeReady;
      await dataSource.query('UPDATE "users" SET "expires_at" = now() - interval \'1 second\' WHERE "id" = $1', [EXPIRING_DEMO_ID]);
      await expect(principalAuthorization.isActive(EXPIRING_DEMO_ID)).resolves.toBe(false);
    } finally {
      releaseRuntime();
    }
    await awaitBeforeTimeout(expiredRunFinished, 5000, 'Expired run did not reach cancellation.');
    unsubscribe();

    expect(seenEvents).not.toContain('assistant.delta');
    expect(seenEvents).not.toContain('run.completed');
    expect(commandProposals.execute).not.toHaveBeenCalled();
    await expect(dataSource.query('SELECT "content" FROM "messages" WHERE "conversation_id" = $1 AND "role" = \'assistant\'', [EXPIRY_CONVERSATION_ID]))
      .resolves.toEqual([]);
    await expect(dataSource.query('SELECT "id" FROM "project_task_suggestions" WHERE "run_id" = $1', [expiryRunId]))
      .resolves.toEqual([]);
    await expect(dataSource.query('SELECT "event_type" FROM "project_task_events" WHERE "run_id" = $1', [expiryRunId]))
      .resolves.toEqual([]);
    const expiredRun: readonly { status: AiRun['status']; cleanup: AiRun['cleanup'] }[] = await dataSource.query('SELECT "status", "cleanup" FROM "ai_runs" WHERE "id" = $1', [expiryRunId]);
    expect(expiredRun[0]).toEqual({ status: 'cancelled', cleanup: 'complete' });
    await dataSource.query('UPDATE "users" SET "role" = \'user\' WHERE "id" = $1', [OTHER_USER_ID]);
    } finally {
      await dataSource.query('DELETE FROM "projects" WHERE "id" = $1', [EXPIRY_PROJECT_ID]);
      await dataSource.query('DELETE FROM "users" WHERE "id" = $1', [EXPIRING_DEMO_ID]);
    }
  }, 60_000);

  it('preserves legacy data, then verifies safe rollback of ownership, identity, and proposal migrations', async () => {
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

    for (let index = 0; index < migrationsFromOwnershipBoundary; index += 1) {
      await dataSource.undoLastMigration({ transaction: 'all' });
    }
    const storageKindColumns: readonly { readonly storage_kind: string | null }[] = await dataSource.query(`
      SELECT column_name AS "storage_kind" FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'storage_kind'
    `);
    expect(storageKindColumns).toHaveLength(0);
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
  await dataSource.query('INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash") VALUES ($1, $2, $3, $4)', [OTHER_USER_ID, 'legacy:test-account', 'Other migration fixture account', 'y']);
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

function testManifest(): EgressManifest {
  return {
    manifestHash: 'a'.repeat(64), provider: 'NVIDIA hosted NIM', providerProfile: 'nvidia-hosted-nim',
    model: 'nvidia/nemotron-3-super-120b-a12b', categories: ['Request'], files: [], requestBytes: 8,
    messageBytes: 0, messageCount: 0, messageHash: 'b'.repeat(64), byteEstimate: 8, tokenEstimate: 2,
    excludedItemCount: 0, omittedItemCount: 0, omissionSummary: 'No selected items were omitted.', bestEffortSecretDetection: true
  };
}

async function createReadyRun(
  dataSource: DataSource,
  runs: TypeOrmAiRunRepository,
  conversationId: string,
  status: 'ready' | 'running',
  ownerId = OWNER_ID,
  projectId = PROJECT_ID,
  storageKind: AiRun['storageKind'] = 'legacy'
): Promise<string> {
  await dataSource.query(
    'INSERT INTO "conversations" ("id", "owner_id", "project_id", "title") VALUES ($1, $2, $3, $4)',
    [conversationId, ownerId, projectId, 'Ownership boundary race']
  );
  const manifest = testManifest();
  const created = await runs.create({
    ownerId, projectId, conversationId,
    request: 'Inspect the project.', relativeRoot: storageKind === 'managed' ? `projects/${projectId}` : 'legacy-project', storageKind, requestedPaths: [], manifest,
    idempotencyKey: `create-${conversationId}`, requestFingerprint: 'd'.repeat(64)
  });
  await runs.recordDecision({
    ownerId, runId: created.resource.id, manifestHash: manifest.manifestHash, decision: 'approve',
    idempotencyKey: `decision-${conversationId}`, requestFingerprint: 'e'.repeat(64)
  });
  await dataSource.query('UPDATE "ai_runs" SET "status" = $1, "phase" = \'inference\', "runtime_kind" = \'fake\', "sandbox_ready" = true WHERE "id" = $2', [status, created.resource.id]);
  return created.resource.id;
}

async function waitForBlockedAccountLock(dataSource: DataSource): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows: readonly { readonly blocked: boolean }[] = await dataSource.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND datname = current_database()
          AND wait_event_type = 'Lock' AND state = 'active'
          AND query ILIKE '%FROM "users"%' AND query ILIKE '%FOR UPDATE%'
      ) AS "blocked"
    `);
    if (rows[0]?.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Account disable did not block behind the active output transaction.');
}

async function awaitBeforeTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
