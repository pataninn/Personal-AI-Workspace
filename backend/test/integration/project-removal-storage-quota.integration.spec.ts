import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmProjectRemovalRepository } from '@/infrastructure/database/repositories/typeorm-project-removal-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { lockProjectWriteState } from '@/infrastructure/database/project-removal-write-barrier';
import { ProjectRecoveryCleaner } from '@/infrastructure/workspace/project-recovery-cleaner';
import type { IProjectRecoveryCleaner } from '@/modules/projects/repositories/project-removal-repository';
import type { StorageResourceReference } from '@/modules/storage-quotas/domain/storage-quota-types';

const DATABASE_NAME = 'home_history_task_3_2_project_removal_test';
const HOME_TITLE = 'workspace home title';
const HOME_RETAINED_TITLE = 'owner home title';
const HOME_MESSAGE_CONTENT = 'workspace home message';
const HOME_EVENT_PAYLOAD = '{"event": "message.appended"}';
const HOME_SCOPE_PROPOSAL_COMMAND = '{"name": "new workspace"}';
const PROJECT_SCOPE_PROPOSAL_COMMAND = '{"objective": "proposal content"}';
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

describeDatabase('Task 3.2 project removal with PostgreSQL and temporary recovery storage', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let recoveryRoot: string;
  let workspaceRoot: string;
  let removalRepository: TypeOrmProjectRemovalRepository;
  let quotaRepository: TypeOrmStorageQuotaRepository;
  let accounting: TypeOrmStorageContentAccounting;
  let mappings: TypeOrmStorageRootMappingRepository;
  let scenario = 0;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded storage-removal integration database URL is required.');
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string; readonly user: string; readonly canCreateDatabase: boolean; readonly databaseExists: boolean;
      }>(`SELECT current_database() AS "database", current_user AS "user",
          (SELECT "rolcreatedb" FROM "pg_roles" WHERE "rolname" = current_user) AS "canCreateDatabase",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "databaseExists"`, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.canCreateDatabase !== true || identity.rows[0]?.databaseExists) {
        throw new Error('The guarded Task 3.2 removal test role cannot safely create its isolated database.');
      }
      await baseClient.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "home_test"`);
      databaseCreated = true;
    } finally {
      await baseClient.end();
    }

    const target = new URL(databaseUrl);
    target.pathname = `/${DATABASE_NAME}`;
    const configured = createDataSource({ url: target.toString() });
    dataSource = new DataSource({ ...configured.options, extra: { max: 1 } });
    await dataSource.initialize();
    const session: readonly { readonly database: string; readonly user: string }[] = await dataSource.query(
      'SELECT current_database() AS "database", current_user AS "user"'
    );
    expect(session).toEqual([{ database: DATABASE_NAME, user: 'home_test' }]);
    const applied = await dataSource.runMigrations({ transaction: 'all' });
    expect(applied).toHaveLength(dataSource.migrations.length);
    quotaRepository = new TypeOrmStorageQuotaRepository(dataSource);
    accounting = new TypeOrmStorageContentAccounting(dataSource, quotaRepository);
    mappings = new TypeOrmStorageRootMappingRepository(dataSource);
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (!databaseCreated || !databaseUrl) return;
    const baseClient = new Client({ connectionString: databaseUrl });
    try {
      await baseClient.connect();
      const identity = await baseClient.query<{
        readonly database: string; readonly user: string; readonly owner: string | null; readonly exists: boolean;
      }>(`SELECT current_database() AS "database", current_user AS "user",
          (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname" = $1) AS "owner",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "exists"`, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.owner !== 'home_test') throw new Error('Refusing to remove the storage-removal database after identity changed.');
      if (!identity.rows[0]?.exists) { databaseCreated = false; return; }
      await baseClient.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [DATABASE_NAME]);
      await baseClient.query(`DROP DATABASE "${DATABASE_NAME}"`);
      databaseCreated = false;
    } finally {
      await baseClient.end();
    }
  }, 120_000);

  beforeEach(async () => {
    scenario += 1;
    recoveryRoot = await mkdtemp(path.join(os.tmpdir(), 'pai-removal-recovery-'));
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'pai-removal-workspace-'));
  });

  afterEach(async () => {
    await rm(recoveryRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('commits the barrier before recovery I/O, blocks a writer, deletes DB content, and retains folder bytes', async () => {
    const scenarioState = await seedProject(scenario);
    const seededIdempotencyReference: readonly { readonly byte_count: string }[] = await dataSource!.query(
      'SELECT "byte_count" FROM "storage_resource_references" WHERE "owner_id" = $1 AND "resource_key" = $2 AND "copy_key" = $3',
      [scenarioState.ownerId, `conversation_idempotency_keys:${scenarioState.idempotencyId}`, 'request_fingerprint']
    );
    expect(seededIdempotencyReference).toEqual([{ byte_count: String(Buffer.byteLength('known-fingerprint-bytes', 'utf8')) }]);
    const seededHomeReferences: readonly { readonly resource_key: string; readonly copy_key: string; readonly byte_count: string }[] = await dataSource!.query(
      `SELECT "resource_key", "copy_key", "byte_count" FROM "storage_resource_references"
       WHERE "owner_id" = $1 AND "resource_key" = ANY($2::text[]) ORDER BY "resource_key", "copy_key"`,
      [scenarioState.ownerId, scenarioState.homeResourceKeys]
    );
    expect(seededHomeReferences).toEqual([
      { resource_key: `home_change_proposal_items:${scenarioState.homeProjectScopeProposalItemId}`, copy_key: 'command', byte_count: String(Buffer.byteLength(PROJECT_SCOPE_PROPOSAL_COMMAND, 'utf8')) },
      { resource_key: `home_change_proposal_items:${scenarioState.homeConversationScopeProposalItemId}`, copy_key: 'command', byte_count: String(Buffer.byteLength(HOME_SCOPE_PROPOSAL_COMMAND, 'utf8')) },
      { resource_key: `home_conversation_events:${scenarioState.homeConversationId}:1`, copy_key: 'payload', byte_count: String(Buffer.byteLength(HOME_EVENT_PAYLOAD, 'utf8')) },
      { resource_key: `home_conversations:${scenarioState.retainedHomeConversationId}`, copy_key: 'title', byte_count: String(Buffer.byteLength(HOME_RETAINED_TITLE, 'utf8')) },
      { resource_key: `home_conversations:${scenarioState.homeConversationId}`, copy_key: 'title', byte_count: String(Buffer.byteLength(HOME_TITLE, 'utf8')) },
      { resource_key: `home_messages:${scenarioState.homeMessageId}`, copy_key: 'content', byte_count: String(Buffer.byteLength(HOME_MESSAGE_CONTENT, 'utf8')) }
    ]);
    const physicalCleaner = new ProjectRecoveryCleaner(recoveryRoot);
    let quarantineEntered: (() => void) | undefined;
    let continueQuarantine: (() => void) | undefined;
    const reachedQuarantine = new Promise<void>((resolve) => { quarantineEntered = resolve; });
    const quarantineGate = new Promise<void>((resolve) => { continueQuarantine = resolve; });
    let observedRemovalBarrier = false;
    const cleaner: IProjectRecoveryCleaner = {
      quarantine: async (runIds) => {
        quarantineEntered?.();
        await quarantineGate;
        return await physicalCleaner.quarantine(runIds);
      },
      restore: (runIds) => physicalCleaner.restore(runIds),
      purge: (runIds) => physicalCleaner.purge(runIds)
    };
    removalRepository = createRemovalRepository(cleaner);
    const removal = removalRepository.remove({ ownerId: scenarioState.ownerId, projectId: scenarioState.projectId, expectedVersion: 1 });

    await reachedQuarantine;
    const writer = dataSource!.createQueryRunner();
    await writer.connect();
    await writer.startTransaction();
    try {
      await writer.query('SELECT "owner_id" FROM "account_limits" WHERE "owner_id" = $1 FOR UPDATE', [scenarioState.ownerId]);
      const state = await lockProjectWriteState(writer, scenarioState.ownerId, scenarioState.projectId);
      observedRemovalBarrier = state?.removalPending === true;
      expect(observedRemovalBarrier).toBe(true);
    } finally {
      await writer.rollbackTransaction();
      await writer.release();
      continueQuarantine?.();
    }

    await removal;
    expect(observedRemovalBarrier).toBe(true);
    await expect(readFile(scenarioState.projectFile, 'utf8')).resolves.toBe(scenarioState.projectContents);
    await expect(readFile(scenarioState.recoveryFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const usage = await quotaRepository.readUsage(scenarioState.ownerId);
    expect(usage).toMatchObject({
      state: 'ready',
      usedBytes: BigInt(Buffer.byteLength(scenarioState.projectContents) + Buffer.byteLength(HOME_RETAINED_TITLE)),
      reservedBytes: 0n
    });
    const rootRows: readonly { readonly project_id: string | null; readonly state: string }[] = await dataSource!.query(
      'SELECT "project_id", "state" FROM "storage_root_mappings" WHERE "owner_id" = $1 AND "root_key" = $2',
      [scenarioState.ownerId, scenarioState.rootKey]
    );
    expect(rootRows).toEqual([{ project_id: null, state: 'retained' }]);
    const references: readonly { readonly resource_kind: string; readonly project_id: string | null; readonly byte_count: string }[] = await dataSource!.query(
      'SELECT "resource_kind", "project_id", "byte_count" FROM "storage_resource_references" WHERE "owner_id" = $1 ORDER BY "resource_kind"',
      [scenarioState.ownerId]
    );
    expect(references).toEqual([
      { resource_kind: 'database_content', project_id: null, byte_count: String(Buffer.byteLength(HOME_RETAINED_TITLE)) },
      { resource_kind: 'retained_root', project_id: null, byte_count: String(Buffer.byteLength(scenarioState.projectContents)) }
    ]);
    const idempotencyReferences: readonly { readonly resource_key: string; readonly copy_key: string; readonly byte_count: string }[] = await dataSource!.query(
      'SELECT "resource_key", "copy_key", "byte_count" FROM "storage_resource_references" WHERE "owner_id" = $1 AND "resource_key" = $2',
      [scenarioState.ownerId, `conversation_idempotency_keys:${scenarioState.idempotencyId}`]
    );
    expect(idempotencyReferences).toEqual([]);
    const homeReferences: readonly { readonly resource_key: string; readonly copy_key: string; readonly byte_count: string }[] = await dataSource!.query(
      'SELECT "resource_key", "copy_key", "byte_count" FROM "storage_resource_references" WHERE "owner_id" = $1 AND "resource_key" = ANY($2::text[])',
      [scenarioState.ownerId, scenarioState.homeResourceKeys]
    );
    expect(homeReferences).toEqual([{
      resource_key: `home_conversations:${scenarioState.retainedHomeConversationId}`,
      copy_key: 'title',
      byte_count: String(Buffer.byteLength(HOME_RETAINED_TITLE, 'utf8'))
    }]);
    await expect(dataSource!.query('SELECT "id" FROM "projects" WHERE "id" = $1', [scenarioState.projectId])).resolves.toEqual([]);
    await expect(dataSource!.query('SELECT "id" FROM "ai_runs" WHERE "id" = $1', [scenarioState.runId])).resolves.toEqual([]);
    await expect(dataSource!.query('SELECT "id" FROM "conversation_idempotency_keys" WHERE "id" = $1', [scenarioState.idempotencyId])).resolves.toEqual([]);
    await expect(dataSource!.query('SELECT "id" FROM "home_conversations" WHERE "id" = $1', [scenarioState.homeConversationId])).resolves.toEqual([]);
    await expect(dataSource!.query('SELECT "id" FROM "home_change_proposal_items" WHERE "id" = ANY($1::uuid[])', [[scenarioState.homeConversationScopeProposalItemId, scenarioState.homeProjectScopeProposalItemId]])).resolves.toEqual([]);
    await expect(dataSource!.query('SELECT "id" FROM "home_conversations" WHERE "id" = $1', [scenarioState.retainedHomeConversationId])).resolves.toHaveLength(1);
    await expect(dataSource!.query('SELECT "project_id" FROM "project_removal_jobs" WHERE "project_id" = $1', [scenarioState.projectId])).resolves.toEqual([]);
  }, 30_000);

  it('restores a quarantined backup from a committed job after a simulated crash', async () => {
    const scenarioState = await seedProject(scenario);
    const expectedUsedBytes = (await quotaRepository.readUsage(scenarioState.ownerId)).usedBytes;
    const physicalCleaner = new ProjectRecoveryCleaner(recoveryRoot);
    const crashAfterQuarantine: IProjectRecoveryCleaner = {
      quarantine: async (runIds) => {
        await physicalCleaner.quarantine(runIds);
        throw new Error('simulated process loss after quarantine');
      },
      restore: (runIds) => physicalCleaner.restore(runIds),
      purge: (runIds) => physicalCleaner.purge(runIds)
    };
    removalRepository = createRemovalRepository(crashAfterQuarantine);

    await expect(removalRepository.remove({ ownerId: scenarioState.ownerId, projectId: scenarioState.projectId, expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'PROJECT_REMOVAL_CLEANUP_PENDING' });
    await expect(readFile(scenarioState.recoveryFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(dataSource!.query('SELECT "project_id" FROM "project_removal_jobs" WHERE "project_id" = $1', [scenarioState.projectId]))
      .resolves.toHaveLength(1);

    await expect(removalRepository.cleanupPending()).resolves.toBe(1);
    await expect(readFile(scenarioState.recoveryFile, 'utf8')).resolves.toBe(scenarioState.recoveryContents);
    await expect(dataSource!.query('SELECT "project_id" FROM "project_removal_jobs" WHERE "project_id" = $1', [scenarioState.projectId]))
      .resolves.toEqual([]);
    await expect(quotaRepository.readUsage(scenarioState.ownerId)).resolves.toMatchObject({
      state: 'ready', usedBytes: expectedUsedBytes
    });
  }, 30_000);

  async function seedProject(index: number): Promise<{
    readonly ownerId: string; readonly projectId: string; readonly runId: string; readonly idempotencyId: string; readonly rootKey: string;
    readonly homeConversationId: string; readonly homeMessageId: string; readonly retainedHomeConversationId: string;
    readonly homeConversationScopeProposalItemId: string; readonly homeProjectScopeProposalItemId: string; readonly homeResourceKeys: readonly string[];
    readonly projectFile: string; readonly projectContents: string; readonly recoveryFile: string; readonly recoveryContents: string;
  }> {
    const suffix = String(index).padStart(12, '0');
    const ownerId = `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
    const projectId = `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`;
    const conversationId = `cccccccc-cccc-4ccc-8ccc-${suffix}`;
    const runId = `dddddddd-dddd-4ddd-8ddd-${suffix}`;
    const homeConversationId = `eeeeeeee-eeee-4eee-8eee-${suffix}`;
    const homeTurnId = `ffffffff-ffff-4fff-8fff-${suffix}`;
    const homeMessageId = `99999999-9999-4999-8999-${suffix}`;
    const retainedHomeConversationId = `55555555-5555-4555-8555-${suffix}`;
    const retainedHomeTurnId = `44444444-4444-4444-8444-${suffix}`;
    const homeConversationScopeProposalId = `88888888-8888-4888-8888-${suffix}`;
    const homeConversationScopeProposalItemId = `77777777-7777-4777-8777-${suffix}`;
    const homeProjectScopeProposalId = `33333333-3333-4333-8333-${suffix}`;
    const homeProjectScopeProposalItemId = `66666666-6666-4666-8666-${suffix}`;
    const relativeRoot = `projects/${projectId}`;
    const rootKey = relativeRoot.toLowerCase();
    const projectContents = 'retained folder bytes';
    const recoveryContents = 'recovery copy bytes';
    const projectFile = path.join(workspaceRoot, ...relativeRoot.split('/'), 'keep.txt');
    const recoveryFile = path.join(recoveryRoot, `run-${runId}`, 'proposal', 'copy.bak');
    await mkdir(path.dirname(projectFile), { recursive: true });
    await mkdir(path.dirname(recoveryFile), { recursive: true });
    await writeFile(projectFile, projectContents, 'utf8');
    await writeFile(recoveryFile, recoveryContents, 'utf8');

    await dataSource!.query(`INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash", "identifier")
      VALUES ($1, $2, 'Removal test', 'fixture-hash', $3)`, [ownerId, `account:remove-${index}`, `remove-${index}`]);
    await dataSource!.query('INSERT INTO "account_limits" ("owner_id", "storage_limit_bytes") VALUES ($1, 1000000)', [ownerId]);
    await dataSource!.query(`INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective")
      VALUES ($1, $2, 'Removal project', $3, $4, $5, 'managed', 'project objective')`,
    [projectId, ownerId, `remove-project-${index}`, relativeRoot, rootKey]);
    await dataSource!.query(`INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
      VALUES ($1, $2, $2, $3, 'managed', $4, 'active')`, [ownerId, projectId, rootKey, relativeRoot]);
    await dataSource!.query('INSERT INTO "conversations" ("id", "owner_id", "project_id", "title") VALUES ($1, $2, $3, $4)',
      [conversationId, ownerId, projectId, 'project conversation']);
    await dataSource!.query(`INSERT INTO "messages" ("conversation_id", "role", "sequence", "content", "content_hash", "content_length")
      VALUES ($1, 'user', 1, 'conversation content', $2, 20)`, [conversationId, 'a'.repeat(64)]);
    const idempotencyRows: readonly { readonly id: string }[] = await dataSource!.query(
      `INSERT INTO "conversation_idempotency_keys" ("owner_id", "project_id", "conversation_id", "operation", "idempotency_key", "request_fingerprint", "resource_id")
       VALUES ($1, $2, $3, 'message', $4, $5, $3) RETURNING "id"`,
      [ownerId, projectId, conversationId, `message-${index}`, 'known-fingerprint-bytes']
    );
    const idempotencyId = idempotencyRows[0]?.id;
    if (!idempotencyId) throw new Error('The removal quota test failed to seed its idempotency row.');
    for (const conversation of [
      { id: homeConversationId, scope: 'workspace', workspaceId: projectId, title: HOME_TITLE, requestKey: `home-${index}` },
      { id: retainedHomeConversationId, scope: 'home', workspaceId: null, title: HOME_RETAINED_TITLE, requestKey: `owner-home-${index}` }
    ]) {
      await dataSource!.query(
        `INSERT INTO "home_conversations" ("id", "owner_id", "scope", "workspace_id", "title", "create_request_key", "create_request_fingerprint")
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [conversation.id, ownerId, conversation.scope, conversation.workspaceId, conversation.title, conversation.requestKey, 'a'.repeat(64)]
      );
    }
    for (const turn of [
      { id: homeTurnId, conversationId: homeConversationId, requestKey: `turn-${index}` },
      { id: retainedHomeTurnId, conversationId: retainedHomeConversationId, requestKey: `owner-turn-${index}` }
    ]) {
      await dataSource!.query(
        `INSERT INTO "home_turns" ("id", "owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint", "status")
         VALUES ($1, $2, $3, 1, $4, $5, 'completed')`,
        [turn.id, ownerId, turn.conversationId, turn.requestKey, 'b'.repeat(64)]
      );
    }
    await dataSource!.query(
      `INSERT INTO "home_messages" ("id", "owner_id", "conversation_id", "turn_id", "sequence", "role", "content", "request_key", "request_fingerprint")
       VALUES ($1, $2, $3, $4, 1, 'user', $5, $6, $7)`,
      [homeMessageId, ownerId, homeConversationId, homeTurnId, HOME_MESSAGE_CONTENT, `message-${index}`, 'c'.repeat(64)]
    );
    await dataSource!.query(
      `INSERT INTO "home_conversation_events" ("owner_id", "conversation_id", "sequence", "event_type", "turn_id", "entity_id", "payload")
       VALUES ($1, $2, 1, 'message.appended', $3, $4, $5::jsonb)`,
      [ownerId, homeConversationId, homeTurnId, homeMessageId, HOME_EVENT_PAYLOAD]
    );
    for (const proposal of [
      {
        id: homeConversationScopeProposalId, itemId: homeConversationScopeProposalItemId,
        conversationId: homeConversationId, turnId: homeTurnId, scope: 'home', scopeId: null,
        requestId: `home-proposal-${index}`, requestFingerprint: 'd'.repeat(64),
        action: 'workspace.create', command: HOME_SCOPE_PROPOSAL_COMMAND
      },
      {
        id: homeProjectScopeProposalId, itemId: homeProjectScopeProposalItemId,
        conversationId: retainedHomeConversationId, turnId: retainedHomeTurnId, scope: 'workspace', scopeId: projectId,
        requestId: `workspace-proposal-${index}`, requestFingerprint: 'e'.repeat(64),
        action: 'workspace.update_objective', command: PROJECT_SCOPE_PROPOSAL_COMMAND
      }
    ]) {
      await dataSource!.query(
        `INSERT INTO "home_change_proposals" ("id", "owner_id", "conversation_id", "source_turn_id", "scope_kind", "scope_id", "runtime_request_id", "request_fingerprint", "item_count", "command_bytes")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)`,
        [proposal.id, ownerId, proposal.conversationId, proposal.turnId, proposal.scope, proposal.scopeId, proposal.requestId, proposal.requestFingerprint, Buffer.byteLength(proposal.command, 'utf8')]
      );
      await dataSource!.query(
        `INSERT INTO "home_change_proposal_items" ("id", "owner_id", "conversation_id", "proposal_id", "position", "action_kind", "target_kind", "target_id", "command")
         VALUES ($1, $2, $3, $4, 0, $5, 'workspace', $6, $7::jsonb)`,
        [proposal.itemId, ownerId, proposal.conversationId, proposal.id, proposal.action, projectId, proposal.command]
      );
    }
    await dataSource!.query(`INSERT INTO "ai_runs" ("id", "owner_id", "project_id", "conversation_id", "request", "relative_root", "storage_kind", "manifest", "manifest_hash", "status", "phase", "decision", "cleanup", "create_idempotency_key", "request_fingerprint", "safe_message")
      VALUES ($1, $2, $3, $4, 'run request', $5, 'managed', '{"files":[]}'::jsonb, $6, 'succeeded', 'terminal', 'approved', 'complete', $7, $6, 'completed')`,
    [runId, ownerId, projectId, conversationId, relativeRoot, 'b'.repeat(64), `run-${index}`]);

    const runner = dataSource!.createQueryRunner();
    await runner.connect();
    let databaseReferences: readonly StorageResourceReference[];
    try { databaseReferences = await accounting.scanDatabaseContent(runner, ownerId); }
    finally { await runner.release(); }
    const recoveryRelativeKey = `run-${runId}/proposal/copy.bak`;
    const homeResourceKeys = [
      `home_change_proposal_items:${homeProjectScopeProposalItemId}`,
      `home_change_proposal_items:${homeConversationScopeProposalItemId}`,
      `home_conversation_events:${homeConversationId}:1`,
      `home_conversations:${retainedHomeConversationId}`,
      `home_conversations:${homeConversationId}`,
      `home_messages:${homeMessageId}`
    ];
    const references: readonly StorageResourceReference[] = [
      ...databaseReferences,
      fileReference(ownerId, projectId, rootKey, 'project_file', rootKey, 'keep.txt', projectContents),
      fileReference(ownerId, projectId, 'recovery-v1', 'recovery_file', runId, recoveryRelativeKey, recoveryContents)
    ];
    await quotaRepository.reconcileReferences(ownerId, references);
    return {
      ownerId, projectId, runId, idempotencyId, rootKey, homeConversationId, homeMessageId, retainedHomeConversationId,
      homeConversationScopeProposalItemId, homeProjectScopeProposalItemId, homeResourceKeys,
      projectFile, projectContents, recoveryFile, recoveryContents
    };
  }

  function createRemovalRepository(cleaner: IProjectRecoveryCleaner): TypeOrmProjectRemovalRepository {
    return new TypeOrmProjectRemovalRepository(dataSource!, cleaner, accounting, quotaRepository, mappings);
  }
});

function fileReference(
  ownerId: string,
  projectId: string,
  rootKey: string,
  kind: 'project_file' | 'recovery_file',
  resourceKey: string,
  relativeKey: string,
  contents: string
): StorageResourceReference {
  return {
    ownerId, kind, resourceKey, copyKey: relativeKey, bytes: BigInt(Buffer.byteLength(contents, 'utf8')), projectId,
    rootKey, relativeKey, sha256: createHash('sha256').update(contents, 'utf8').digest('hex')
  };
}
