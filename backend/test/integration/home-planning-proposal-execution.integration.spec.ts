import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { TypeOrmActionLedgerRepository } from '@/infrastructure/database/repositories/typeorm-action-ledger-repository';
import { TypeOrmHomeActionEventRecorder } from '@/infrastructure/database/repositories/typeorm-home-action-event-recorder';
import { TypeOrmHomeChangeProposalRepository } from '@/infrastructure/database/repositories/typeorm-home-change-proposal-repository';
import { TypeOrmHomeConversationRepository } from '@/infrastructure/database/repositories/typeorm-home-conversation-repository';
import { TypeOrmProjectRepository } from '@/infrastructure/database/repositories/typeorm-project-repository';
import { TypeOrmProjectTaskRepository } from '@/infrastructure/database/repositories/typeorm-project-task-repository';
import { WorkspaceBoundaryAdapter } from '@/infrastructure/workspace/workspace-boundary';
import { ActionUndoUseCases } from '@/modules/home-assistant/use-cases/action-undo-use-cases';
import { HomePlanningToolRequestHandler } from '@/modules/home-assistant/use-cases/home-planning-tool-request-handler';
import { WorkspacePlanningUseCases, type IWorkspacePlanningUseCases } from '@/modules/projects/use-cases/workspace-planning-use-cases';
import { GetGlobalTaskUseCase, ListGlobalTasksUseCase } from '@/modules/tasks/use-cases/global-task-query-use-cases';
import { TaskMutationUseCases } from '@/modules/tasks/use-cases/task-mutation-use-cases';

const OWNER_ID = '4a103333-3333-4333-8333-333333333333';
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;

if (databaseUrl) {
  const testDatabaseUrl = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(testDatabaseUrl.protocol)
    || !new Set(['127.0.0.1', 'localhost', '::1', '[::1]']).has(testDatabaseUrl.hostname)
    || testDatabaseUrl.port !== '55441'
    || testDatabaseUrl.pathname !== '/home_history_test'
    || testDatabaseUrl.username !== 'home_test') {
    throw new Error('HOME_CONVERSATION_TEST_DATABASE_URL must target home_test/home_history_test on loopback port 55441.');
  }
}

const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('Home accepted proposal PostgreSQL integration', () => {
  const dataSource = createDataSource({ url: databaseUrl ?? 'postgres://disabled:disabled@127.0.0.1:1/disabled' });
  let conversations: TypeOrmHomeConversationRepository;
  let proposals: TypeOrmHomeChangeProposalRepository;
  let handler: HomePlanningToolRequestHandler;
  let workspaces: IWorkspacePlanningUseCases;

  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    const migrations: readonly { name: string }[] = await dataSource.query('SELECT "name" FROM "migrations"');
    expect(migrations).toHaveLength(dataSource.migrations.length);
    expect(migrations.map((migration) => migration.name)).toContain('CreateHomeChangeProposals1710000025000');
    await dataSource.query('DELETE FROM "home_change_proposals" WHERE "owner_id" = $1', [OWNER_ID]);
    await dataSource.query('DELETE FROM "users" WHERE "id" = $1', [OWNER_ID]);
    await dataSource.query(
      'INSERT INTO "users" ("id", "scope_key", "identifier", "display_name", "password_hash") VALUES ($1, $2, $3, $4, $5)',
      [OWNER_ID, 'home-proposal-execution-test', 'home-proposal-execution-test', 'Home Proposal Test', 'x']
    );

    conversations = new TypeOrmHomeConversationRepository(dataSource);
    proposals = new TypeOrmHomeChangeProposalRepository(dataSource);
    const ledger = new TypeOrmActionLedgerRepository(dataSource, new TypeOrmHomeActionEventRecorder());
    const tasks = new TypeOrmProjectTaskRepository(dataSource);
    const projects = new TypeOrmProjectRepository(dataSource);
    const taskMutations = new TaskMutationUseCases(ledger, tasks, tasks);
    const workspaceBoundary = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace', identityFile: '/workspace/.personal-ai-workspace-identity', expectedIdentity: 'integration-fixture'
    });
    workspaces = new WorkspacePlanningUseCases(projects, projects, ledger, workspaceBoundary);
    handler = new HomePlanningToolRequestHandler({
      principalAuthorization: { assertActive: async () => undefined },
      executionPolicy: { assertHome: async ({ projectId }: { readonly projectId?: string }) => ({
        policies: [],
        effectiveCapabilities: ['home_task_read', 'home_task_write', 'home_workspace_read', 'home_workspace_write', 'home_action_undo'],
        revisions: { home: '1', ...(projectId ? { workspace: '1' } : {}) }
      }) },
      provider: { profile: 'test-provider', model: 'test-model' },
      conversations,
      listTasks: new ListGlobalTasksUseCase(tasks),
      getTask: new GetGlobalTaskUseCase(tasks),
      taskMutations,
      workspaces,
      undo: new ActionUndoUseCases(ledger, tasks, projects)
    });
    await reconcileRootlessOwner(dataSource, OWNER_ID);
  }, 120_000);

  afterAll(async () => {
    if (dataSource.isInitialized) {
      try {
        await dataSource.query('DELETE FROM "home_change_proposals" WHERE "owner_id" = $1', [OWNER_ID]);
        await dataSource.query('DELETE FROM "users" WHERE "id" = $1', [OWNER_ID]);
      } finally {
        await dataSource.destroy();
      }
    }
  });

  it('blocks Home and workspace bulk proposals before any retained write', async () => {
    const workspace = await workspaces.createPlanning({ ownerId: OWNER_ID, operationKey: 'bulk-proposal-disabled-workspace', name: 'Synthetic scope fixture', actorKind: 'manual' });
    const createTurn = async (scope: { readonly kind: 'home' } | { readonly kind: 'workspace'; readonly workspaceId: string }, key: string) => {
      const conversation = (await conversations.create({
        ownerId: OWNER_ID, scope, title: `Bulk proposal ${key}`,
        requestKey: `${key}-conversation`, requestFingerprint: `${key}-conversation-fingerprint`
      })).resource;
      const submitted = await conversations.submitTurn({
        ownerId: OWNER_ID, conversationId: conversation.id, requestKey: `${key}-turn`,
        requestFingerprint: `${key}-turn-fingerprint`, message: 'Create two synthetic tasks.', initialStatus: 'pending',
        homePolicyRevision: '1', workspacePolicyRevision: scope.kind === 'workspace' ? '1' : null
      });
      const running = await conversations.updateTurnStatus({ ownerId: OWNER_ID, conversationId: conversation.id, turnId: submitted.turn.id, status: 'running' });
      if (!running) throw new Error('The synthetic bulk proposal turn did not enter running state.');
      return { conversation, turn: running };
    };
    const home = await createTurn({ kind: 'home' }, 'home-bulk-disabled');
    const project = await createTurn({ kind: 'workspace', workspaceId: workspace.project.id }, 'workspace-bulk-disabled');
    const toolArgs = { items: [
      { action: 'task.create', title: 'Unsupported retained bulk task one' },
      { action: 'task.create', title: 'Unsupported retained bulk task two' }
    ] };

    await expect(handler.resolve({
      ownerId: OWNER_ID, conversationId: home.conversation.id, turnId: home.turn.id, scope: { kind: 'home' },
      requestId: 'home-bulk-disabled', name: 'home_propose_bulk_changes', args: toolArgs
    })).resolves.toBeNull();
    await expect(handler.resolve({
      ownerId: OWNER_ID, conversationId: project.conversation.id, turnId: project.turn.id, scope: { kind: 'workspace', workspaceId: workspace.project.id },
      requestId: 'workspace-bulk-disabled', name: 'home_propose_bulk_changes', args: toolArgs
    })).resolves.toBeNull();

    expect((await proposals.listForOwner({ ownerId: OWNER_ID, conversationId: home.conversation.id, limit: 20 }))?.proposals).toEqual([]);
    expect((await proposals.listForOwner({ ownerId: OWNER_ID, conversationId: project.conversation.id, limit: 20 }))?.proposals).toEqual([]);
    const retainedTasks: readonly { count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS "count" FROM "project_tasks" WHERE "owner_id" = $1 AND "title" = ANY($2::text[])',
      [OWNER_ID, ['Unsupported retained bulk task one', 'Unsupported retained bulk task two']]
    );
    expect(Number(retainedTasks[0]?.count)).toBe(0);
    const savedProposals: readonly { count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS "count" FROM "home_change_proposals" WHERE "owner_id" = $1 AND "source_turn_id" = ANY($2::uuid[])',
      [OWNER_ID, [home.turn.id, project.turn.id]]
    );
    expect(Number(savedProposals[0]?.count)).toBe(0);
    const receipts: readonly { count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS "count" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "turn_id" = ANY($2::uuid[])',
      [OWNER_ID, [home.turn.id, project.turn.id]]
    );
    expect(Number(receipts[0]?.count)).toBe(0);
  }, 120_000);
});

async function reconcileRootlessOwner(dataSource: DataSource, ownerId: string): Promise<void> {
  const mappings = await new TypeOrmStorageRootMappingRepository(dataSource).listMappings(ownerId);
  const rootedProjects: readonly { count: string }[] = await dataSource.query(
    'SELECT COUNT(*)::text AS "count" FROM "projects" WHERE "owner_id" = $1 AND "relative_root" IS NOT NULL', [ownerId]
  );
  if (mappings.length > 0 || Number(rootedProjects[0]?.count ?? '0') > 0) {
    throw new Error('The Home proposal fixture unexpectedly contains a physical storage root.');
  }

  const quota = new TypeOrmStorageQuotaRepository(dataSource);
  const references = await scanDatabaseOwner(dataSource, new TypeOrmStorageContentAccounting(dataSource, quota), ownerId);
  await quota.reconcileReferences(ownerId, references);
}

async function scanDatabaseOwner(
  dataSource: DataSource,
  accounting: TypeOrmStorageContentAccounting,
  ownerId: string
) {
  const runner = dataSource.createQueryRunner();
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
