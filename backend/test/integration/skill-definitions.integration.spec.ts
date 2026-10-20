import type { DataSource, QueryRunner } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmHomeConversationRepository } from '@/infrastructure/database/repositories/typeorm-home-conversation-repository';
import { TypeOrmProjectChatContextRepository } from '@/infrastructure/database/repositories/typeorm-project-chat-context-repository';
import { TypeOrmProjectFactRepository } from '@/infrastructure/database/repositories/typeorm-project-fact-repository';
import { TypeOrmProjectRepository } from '@/infrastructure/database/repositories/typeorm-project-repository';
import { TypeOrmProjectRemovalRepository } from '@/infrastructure/database/repositories/typeorm-project-removal-repository';
import { TypeOrmSkillInvocationRepository } from '@/infrastructure/database/repositories/typeorm-skill-invocation-repository';
import { TypeOrmSkillRepository } from '@/infrastructure/database/repositories/typeorm-skill-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { ProjectChatContextUseCases } from '@/modules/ai-runs/use-cases/project-chat-context-use-cases';
import type { AssistantScopePolicy } from '@/modules/assistant-policy/domain/assistant-scope-policy';
import type { AssistantExecutionAuthorization } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import { GetHomeTurnUseCase } from '@/modules/home-assistant/use-cases/get-home-turn';
import { InvokeSkillUseCase } from '@/modules/skills/use-cases/invoke-skill';
import { ListHomeSkillRunSummariesUseCase } from '@/modules/skills/use-cases/list-home-skill-run-summaries';
import type { HomePlanningProvider, IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import { SubmitHomeTurnUseCase, type HomeExecutionPolicyConfiguration, type HomeTurnRuntimeConfiguration } from '@/modules/home-assistant/use-cases/submit-home-turn';
import { DeleteProjectUseCase } from '@/modules/projects/use-cases/delete-project';
import type { IProjectRecoveryCleaner } from '@/modules/projects/repositories/project-removal-repository';

const DATABASE_NAME = 'home_history_task_6_2_skill_test';
const OWNER_ID = 'd6620000-0000-4000-8000-000000000101';
const OTHER_OWNER_ID = 'd6620000-0000-4000-8000-000000000102';
const WORKSPACE_ID = 'd6620000-0000-4000-8000-000000000103';
const CONVERSATION_ID = 'd6620000-0000-4000-8000-000000000104';
const TURN_ID = 'd6620000-0000-4000-8000-000000000105';
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

describeDatabase('Task 6.2 skill definitions PostgreSQL integration', () => {
  let dataSource: DataSource | undefined;
  let databaseCreated = false;
  let skills: TypeOrmSkillRepository;
  let invocations: TypeOrmSkillInvocationRepository;
  let quota: TypeOrmStorageQuotaRepository;
  let accounting: TypeOrmStorageContentAccounting;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('The guarded skill integration database URL is required.');
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
        throw new Error('The guarded skill test role cannot safely create its isolated database.');
      }
      await baseClient.query(`CREATE DATABASE "${DATABASE_NAME}" OWNER "home_test"`);
      databaseCreated = true;
    } finally {
      await baseClient.end();
    }

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

    quota = new TypeOrmStorageQuotaRepository(dataSource);
    accounting = new TypeOrmStorageContentAccounting(dataSource, quota);
    skills = new TypeOrmSkillRepository(dataSource, accounting);
    invocations = new TypeOrmSkillInvocationRepository(dataSource);
  }, 120_000);

  beforeEach(async () => {
    const source = requiredDataSource();
    await source.query('TRUNCATE TABLE "users" CASCADE');
    await source.query(`
      INSERT INTO "users" ("id", "scope_key", "identifier", "account_kind", "role", "display_name", "password_hash")
      VALUES ($1, 'account:skill-owner', 'skill-owner', 'regular', 'user', 'Skill owner', 'fixture-hash'),
             ($2, 'account:skill-other-owner', 'skill-other-owner', 'regular', 'user', 'Other skill owner', 'fixture-hash')
    `, [OWNER_ID, OTHER_OWNER_ID]);
    await source.query('INSERT INTO "account_limits" ("owner_id", "storage_limit_bytes") VALUES ($1, 100000), ($2, 100000)', [OWNER_ID, OTHER_OWNER_ID]);
    await source.query(`
      INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key")
      VALUES ($1, $2, 'Skill workspace', 'skill-workspace', NULL, NULL)
    `, [WORKSPACE_ID, OWNER_ID]);
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
          (SELECT pg_get_userbyid("datdba") FROM "pg_database" WHERE "datname" = $1) AS "owner",
          EXISTS (SELECT 1 FROM "pg_database" WHERE "datname" = $1) AS "exists"`, [DATABASE_NAME]);
      if (identity.rows[0]?.database !== 'home_history_test' || identity.rows[0]?.user !== 'home_test'
        || identity.rows[0]?.owner !== 'home_test') {
        throw new Error('Refusing to remove the skill test database after its guarded identity changed.');
      }
      if (!identity.rows[0]?.exists) { databaseCreated = false; return; }
      await baseClient.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [DATABASE_NAME]);
      await baseClient.query(`DROP DATABASE "${DATABASE_NAME}"`);
      databaseCreated = false;
    } finally {
      await baseClient.end();
    }
  }, 30_000);

  it('versions and charges immutable history, replays owner-scoped keys, and cannot revive a deleted skill', async () => {
    const baselineBytes = (await quota.readUsage(OWNER_ID)).usedBytes ?? 0n;
    const createInput = {
      ownerId: OWNER_ID,
      workspaceId: WORKSPACE_ID,
      idempotencyKeyDigest: 'a'.repeat(64),
      requestFingerprint: 'b'.repeat(64),
      title: 'Daily review',
      instructions: 'Read today’s tasks and summarize the next action.',
      enabled: true,
      declaredTools: ['home_task_read'] as const
    };
    const created = await skills.create(createInput);
    expect(created.replayed).toBe(false);
    const firstRevisionBytes = skillBytes(createInput.title, createInput.instructions, createInput.declaredTools);
    await expect(quota.readUsage(OWNER_ID)).resolves.toMatchObject({ state: 'ready', usedBytes: baselineBytes + firstRevisionBytes, reservedBytes: 0n });

    const updated = await skills.update({
      ownerId: OWNER_ID, skillId: created.skill.id, workspaceId: WORKSPACE_ID, expectedVersion: 1,
      title: 'Daily review v2', instructions: 'Read tasks, summarize the next action, and mention blockers.',
      enabled: true, declaredTools: ['home_task_read']
    });
    if (!updated) throw new Error('The expected skill version should update.');
    expect(updated.version).toBe(2);
    const secondRevisionBytes = skillBytes(updated.title, updated.instructions, updated.declaredTools);
    const expectedHistoryBytes = baselineBytes + firstRevisionBytes + secondRevisionBytes;
    await expect(quota.readUsage(OWNER_ID)).resolves.toMatchObject({ state: 'ready', usedBytes: expectedHistoryBytes, reservedBytes: 0n });
    const historyReferences: readonly { readonly resource_key: string; readonly copy_key: string }[] = await requiredDataSource().query(`
      SELECT "resource_key", "copy_key" FROM "storage_resource_references"
      WHERE "owner_id"=$1 AND "resource_kind"='database_content' AND "resource_key" LIKE 'skill_revisions:%'
      ORDER BY "resource_key", "copy_key"
    `, [OWNER_ID]);
    expect(historyReferences).toHaveLength(6);

    await requiredDataSource().query('UPDATE "account_limits" SET "storage_limit_bytes"=$2 WHERE "owner_id"=$1', [OWNER_ID, String(expectedHistoryBytes)]);
    await expect(skills.update({
      ownerId: OWNER_ID, skillId: created.skill.id, workspaceId: WORKSPACE_ID, expectedVersion: 2,
      title: 'Daily review v3', instructions: 'A larger revision that must fail because the immutable history remains charged.',
      enabled: true, declaredTools: ['home_task_read']
    })).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED', statusCode: 413 });
    await expect(skills.findActiveById(OWNER_ID, created.skill.id)).resolves.toMatchObject({ version: 2, title: 'Daily review v2' });
    await expect(quota.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: expectedHistoryBytes, reservedBytes: 0n });

    await expect(skills.create(createInput)).resolves.toMatchObject({ skill: { id: created.skill.id, version: 2 }, replayed: true });
    await expect(skills.create({ ...createInput, requestFingerprint: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'SKILL_IDEMPOTENCY_KEY_REUSED' });

    const otherOwnerSkill = await skills.create({ ...createInput, ownerId: OTHER_OWNER_ID, workspaceId: null });
    expect(otherOwnerSkill.skill.id).not.toBe(created.skill.id);
    await expect(skills.findActiveById(OTHER_OWNER_ID, created.skill.id)).resolves.toBeNull();
    await expect(skills.listActive(OWNER_ID, WORKSPACE_ID)).resolves.toHaveLength(1);
    await expect(skills.listActive(OTHER_OWNER_ID)).resolves.toHaveLength(1);
    await expect(quota.readUsage(OTHER_OWNER_ID)).resolves.toMatchObject({ usedBytes: firstRevisionBytes, reservedBytes: 0n });

    await expect(skills.softDelete({ ownerId: OWNER_ID, skillId: created.skill.id, expectedVersion: 2 })).resolves.toMatchObject({ version: 2 });
    await expect(skills.findActiveById(OWNER_ID, created.skill.id)).resolves.toBeNull();
    await expect(skills.create(createInput)).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND', statusCode: 404 });
    await expect(quota.readUsage(OWNER_ID)).resolves.toMatchObject({ usedBytes: expectedHistoryBytes, reservedBytes: 0n });
  });

  it('purges workspace conversations and invocations while releasing skill revision quota on hard delete', async () => {
    const skill = await skills.create({
      ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
      idempotencyKeyDigest: 'd'.repeat(64), requestFingerprint: 'e'.repeat(64),
      title: 'Workspace reader', instructions: 'Read tasks in this workspace.', enabled: true, declaredTools: ['home_task_read']
    });
    await requiredDataSource().query(`
      INSERT INTO "home_conversations" ("id", "owner_id", "scope", "workspace_id", "title", "create_request_key", "create_request_fingerprint")
      VALUES ($1, $2, 'workspace', $3, 'Workspace skill', 'create-skill-test', $4)
    `, [CONVERSATION_ID, OWNER_ID, WORKSPACE_ID, 'f'.repeat(64)]);
    const invocation = await invocations.claim({
      ownerId: OWNER_ID, conversationId: CONVERSATION_ID,
      skillId: skill.skill.id, skillRevisionId: skill.skill.revisionId, skillVersion: skill.skill.version,
      requestKeyDigest: '1'.repeat(64), requestFingerprint: '2'.repeat(64), contextRevisions: []
    });
    await invocations.updateState(OWNER_ID, invocation.id, 'bound');
    await invocations.updateState(OWNER_ID, invocation.id, 'dispatching');
    await requiredDataSource().query(`
      INSERT INTO "home_turns" ("id", "owner_id", "conversation_id", "sequence", "request_key", "request_fingerprint", "status", "skill_invocation_id")
      VALUES ($1, $2, $3, 1, 'skill-turn', $4, 'running', $5)
    `, [TURN_ID, OWNER_ID, CONVERSATION_ID, '3'.repeat(64), invocation.id]);
    await expect(invocations.findForTurn(OWNER_ID, CONVERSATION_ID, TURN_ID)).resolves.toMatchObject({ id: invocation.id, current: true });

    const noFilesystem: IProjectRecoveryCleaner = {
      quarantine: async () => ({ restore: async () => undefined, purge: async () => undefined }),
      restore: async () => undefined,
      purge: async () => undefined
    };
    const removal = new DeleteProjectUseCase(new TypeOrmProjectRemovalRepository(
      requiredDataSource(), noFilesystem, accounting, quota, new TypeOrmStorageRootMappingRepository(requiredDataSource())
    ));
    await removal.execute({ ownerId: OWNER_ID, projectId: WORKSPACE_ID, expectedVersion: 1 });

    const purgeCounts: readonly {
      readonly conversations: string; readonly turns: string; readonly invocations: string; readonly contentReferences: string;
    }[] = await requiredDataSource().query(`
      SELECT
        (SELECT count(*)::text FROM "home_conversations" WHERE "owner_id"=$1 AND "id"=$2) AS "conversations",
        (SELECT count(*)::text FROM "home_turns" WHERE "owner_id"=$1 AND "id"=$3) AS "turns",
        (SELECT count(*)::text FROM "skill_invocations" WHERE "owner_id"=$1 AND "id"=$4) AS "invocations",
        (SELECT count(*)::text FROM "storage_resource_references" WHERE "owner_id"=$1 AND "resource_kind"='database_content') AS "contentReferences"
    `, [OWNER_ID, CONVERSATION_ID, TURN_ID, invocation.id]);
    expect(purgeCounts).toEqual([{ conversations: '0', turns: '0', invocations: '0', contentReferences: '0' }]);
    await expect(invocations.findForTurn(OWNER_ID, CONVERSATION_ID, TURN_ID)).resolves.toBeNull();
    await expect(quota.readUsage(OWNER_ID)).resolves.toMatchObject({ state: 'ready', usedBytes: 0n, reservedBytes: 0n });
  });

  it('persists a managed skill run and reloads its Home summary within the owning account', async () => {
    const created = await skills.create({
      ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
      idempotencyKeyDigest: '4'.repeat(64), requestFingerprint: '5'.repeat(64),
      title: 'Plan my day', instructions: 'Review saved workspace tasks.', enabled: true, declaredTools: ['home_task_read']
    });
    const source = requiredDataSource();
    const factRepository = new TypeOrmProjectFactRepository(source, accounting);
    const fact = await factRepository.create({
      ownerId: OWNER_ID,
      projectId: WORKSPACE_ID,
      key: 'daily-focus',
      title: 'Workspace priority',
      content: 'Protect morning focus time for the migration.'
    });
    const chatContext = new TypeOrmProjectChatContextRepository(source);
    await chatContext.update(OWNER_ID, WORKSPACE_ID, { factIds: [fact.id] });
    const projectContext = new ProjectChatContextUseCases(
      new TypeOrmProjectRepository(source, accounting), chatContext, factRepository, {} as never
    );
    const conversations = new TypeOrmHomeConversationRepository(requiredDataSource(), accounting);
    const conversation = (await conversations.create({
      ownerId: OWNER_ID, scope: { kind: 'workspace', workspaceId: WORKSPACE_ID }, title: 'Plan my day',
      requestKey: 'managed-skill-conversation-create', requestFingerprint: '6'.repeat(64)
    })).resource;
    const provider: HomePlanningProvider = { profile: 'fixture-local', model: 'deterministic-test', endpoint: 'https://fixture.invalid' };
    const runtime: IHomePlanningRuntime = {
      supportsPolicyExecution: async () => true,
      start: async ({ prompt }) => {
        startedPrompts.push(prompt);
        return { outcome: 'accepted' };
      },
      poll: async () => ({
        status: 'completed',
        events: [{ sequence: 1, type: 'assistant.delta', text: 'Plan: protect morning focus time for the migration.' }],
        nextCursor: 1,
        hasMore: false
      }),
      sendToolResult: async () => ({ accepted: true }),
      cancel: async () => ({ outcome: 'confirmed' }),
      delete: async () => undefined
    };
    const runtimeConfiguration: HomeTurnRuntimeConfiguration = { mode: 'hermes', runtime, provider };
    const policy = managedWorkspacePolicy(OWNER_ID, WORKSPACE_ID, provider);
    const executionPolicy = {
      assertHome: async (input: {
        readonly ownerId: string;
        readonly projectId?: string;
        readonly providerProfile: string;
        readonly model: string;
        readonly homePolicyRevision?: string;
        readonly workspacePolicyRevision?: string;
      }) => {
        if (input.ownerId !== OWNER_ID || input.projectId !== WORKSPACE_ID
          || input.providerProfile !== provider.profile || input.model !== provider.model
          || (input.homePolicyRevision !== undefined && input.homePolicyRevision !== '1')
          || (input.workspacePolicyRevision !== undefined && input.workspacePolicyRevision !== '2')) {
          throw new Error('The fixture policy revision changed.');
        }
        return policy;
      }
    };
    const policyConfiguration: HomeExecutionPolicyConfiguration = {
      executionPolicy,
      providerProfile: provider.profile,
      model: provider.model
    };
    const startedPrompts: string[] = [];
    const submitTurn = new SubmitHomeTurnUseCase(
      conversations,
      runtimeConfiguration,
      policyConfiguration,
      { readSelectedFacts: (ownerId, projectId) => projectContext.getSelectedFacts(ownerId, projectId) }
    );
    const invoke = new InvokeSkillUseCase(skills, invocations, conversations, submitTurn);
    const result = await invoke.execute({
      ownerId: OWNER_ID, skillId: created.skill.id, conversationId: conversation.id,
      expectedVersion: 1, requestKey: 'managed-skill-invocation-1', request: 'Plan my day.'
    });
    const turnId = result.invocation.turnId;
    if (!turnId) throw new Error('The persisted skill invocation should have a Home turn.');
    expect(result.invocation.state).toBe('running');
    expect(result.invocation.contextRevisions).toEqual([{ kind: 'project_fact', id: fact.id, revision: fact.version }]);
    expect(startedPrompts).toHaveLength(1);
    expect(startedPrompts[0]).toContain('Protect morning focus time for the migration.');

    const getTurn = new GetHomeTurnUseCase(conversations, runtime, undefined, undefined, policyConfiguration);
    await expect(getTurn.execute({ ownerId: OWNER_ID, conversationId: conversation.id, turnId })).resolves.toMatchObject({
      id: turnId, status: 'completed', homePolicyRevision: '1', workspacePolicyRevision: '2'
    });
    const savedMessages = await conversations.listMessagesForOwner({ ownerId: OWNER_ID, conversationId: conversation.id, limit: 10, transcriptOnly: true });
    expect(savedMessages?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: 'Plan: protect morning focus time for the migration.' })
    ]));

    const turns = await conversations.listTurnsForOwner({ ownerId: OWNER_ID, conversationId: conversation.id, limit: 10, afterSequence: 0 });
    expect(turns?.turns.map((turn) => turn.id)).toContain(turnId);
    const summaries = new ListHomeSkillRunSummariesUseCase(invocations);
    const reloadedSummaries = await summaries.execute({ ownerId: OWNER_ID, conversationId: conversation.id, turnIds: [turnId] });
    expect(typeof reloadedSummaries[0]?.summary.sources[0]?.revision).toBe('number');
    expect(reloadedSummaries).toEqual([{
      turnId, summary: {
        title: 'Plan my day', skillVersion: 1, state: 'accepted',
        sources: [{ kind: 'project_fact', revision: fact.version, label: 'Workspace priority' }]
      }
    }]);
    expect(await conversations.findForOwner(OTHER_OWNER_ID, conversation.id)).toBeNull();
    expect(await conversations.listTurnsForOwner({ ownerId: OTHER_OWNER_ID, conversationId: conversation.id, limit: 10, afterSequence: 0 })).toBeNull();
    await expect(summaries.execute({ ownerId: OTHER_OWNER_ID, conversationId: conversation.id, turnIds: [turnId] })).resolves.toEqual([]);
  });

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
    if (!dataSource?.isInitialized) throw new Error('The isolated skill database is not initialized.');
    return dataSource;
  }
});

function managedWorkspacePolicy(ownerId: string, workspaceId: string, provider: HomePlanningProvider): AssistantExecutionAuthorization {
  const now = new Date('2026-10-20T00:00:00.000Z');
  const homePolicy: AssistantScopePolicy = {
    id: 'd6620000-0000-4000-8000-000000000116', ownerId, scopeKind: 'home', projectId: null,
    policyProfile: 'home_in_scope_v1', providerProfile: provider.profile, model: provider.model,
    enabled: true, revokedAt: null, revision: '1', createdAt: now, updatedAt: now
  };
  const workspacePolicy: AssistantScopePolicy = {
    id: 'd6620000-0000-4000-8000-000000000117', ownerId, scopeKind: 'project', projectId: workspaceId,
    policyProfile: 'workspace_in_scope_v1', providerProfile: provider.profile, model: provider.model,
    enabled: true, revokedAt: null, revision: '2', createdAt: now, updatedAt: now
  };
  return { policies: [homePolicy, workspacePolicy], effectiveCapabilities: [], revisions: { home: '1', workspace: '2' } };
}

function skillBytes(title: string, instructions: string, tools: readonly string[]): bigint {
  return BigInt(Buffer.byteLength(title) + Buffer.byteLength(instructions) + Buffer.byteLength(JSON.stringify(tools)));
}
