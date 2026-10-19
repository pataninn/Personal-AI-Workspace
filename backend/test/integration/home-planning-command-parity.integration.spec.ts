import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmActionLedgerRepository } from '@/infrastructure/database/repositories/typeorm-action-ledger-repository';
import { TypeOrmHomeActionEventRecorder } from '@/infrastructure/database/repositories/typeorm-home-action-event-recorder';
import { TypeOrmHomeChangeProposalRepository } from '@/infrastructure/database/repositories/typeorm-home-change-proposal-repository';
import { TypeOrmHomeConversationRepository } from '@/infrastructure/database/repositories/typeorm-home-conversation-repository';
import { TypeOrmProjectRepository } from '@/infrastructure/database/repositories/typeorm-project-repository';
import { TypeOrmProjectTaskRepository } from '@/infrastructure/database/repositories/typeorm-project-task-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { StorageQuotaRootScanner, type TrustedStorageRoot } from '@/infrastructure/workspace/storage-quota-reconciliation';
import type { StorageResourceReference } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { StorageRootMapping } from '@/modules/storage-quotas/repositories/storage-root-mapping-repository';
import { WorkspaceBoundaryAdapter } from '@/infrastructure/workspace/workspace-boundary';
import { ActionUndoUseCases } from '@/modules/home-assistant/use-cases/action-undo-use-cases';
import { HomePlanningScopeConflictError } from '@/modules/home-assistant/domain/home-planning-errors';
import type { HomeConversationScope } from '@/modules/home-assistant/domain/home-conversation-types';
import { HomeChangeProposalUseCases } from '@/modules/home-assistant/use-cases/home-change-proposal-use-cases';
import { HomePlanningToolRequestHandler } from '@/modules/home-assistant/use-cases/home-planning-tool-request-handler';
import type { HomePlanningToolResolution } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';
import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import { ProjectTaskArchivedError, ProjectTaskArchivedProjectError, ProjectTaskIdempotencyReusedError, ProjectTaskOrderConflictError } from '@/modules/tasks/domain/project-task-errors';
import { WorkspacePlanningUseCases } from '@/modules/projects/use-cases/workspace-planning-use-cases';
import { GetGlobalTaskUseCase, ListGlobalTasksUseCase } from '@/modules/tasks/use-cases/global-task-query-use-cases';
import { TaskMutationUseCases } from '@/modules/tasks/use-cases/task-mutation-use-cases';

const OWNER_ID = '4a101111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '4a102222-2222-4222-8222-222222222222';
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;

if (databaseUrl) {
  const testDatabaseUrl = new URL(databaseUrl);
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (!['postgres:', 'postgresql:'].includes(testDatabaseUrl.protocol)
    || !allowedHosts.has(testDatabaseUrl.hostname)
    || testDatabaseUrl.port !== '55441'
    || testDatabaseUrl.pathname !== '/home_history_test'
    || testDatabaseUrl.username !== 'home_test') {
    throw new Error('HOME_CONVERSATION_TEST_DATABASE_URL must target home_test/home_history_test on loopback port 55441.');
  }
}

const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('Home planning canonical command parity PostgreSQL integration', () => {
  const dataSource = createDataSource({ url: databaseUrl ?? 'postgres://disabled:disabled@127.0.0.1:1/disabled' });
  let conversations: TypeOrmHomeConversationRepository;
  let projects: TypeOrmProjectRepository;
  let tasks: TypeOrmProjectTaskRepository;
  let ledger: TypeOrmActionLedgerRepository;
  let changeProposals: HomeChangeProposalUseCases;
  let handler: HomePlanningToolRequestHandler;
  let managedRoot: string;
  let recoveryRoot: string;
  let fileWorkspaceId: string;
  let dotWorkspaceId: string;

  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    const migrations: readonly { name: string }[] = await dataSource.query('SELECT "name" FROM "migrations"');
    expect(migrations).toHaveLength(dataSource.migrations.length);
    expect(migrations.map((migration) => migration.name)).toContain('CreateHomeChangeProposals1710000025000');

    await dataSource.query('DELETE FROM "home_change_proposal_items" WHERE "owner_id" = ANY($1::uuid[])', [[OWNER_ID, OTHER_OWNER_ID]]);
    await dataSource.query('DELETE FROM "users" WHERE "id" IN ($1, $2)', [OWNER_ID, OTHER_OWNER_ID]);
    managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pai-home-parity-managed-'));
    recoveryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pai-home-parity-recovery-'));
    await dataSource.query(
      `INSERT INTO "users" ("id", "scope_key", "identifier", "display_name", "password_hash") VALUES
       ($1, 'planning-parity-owner', 'planning-parity-owner', 'Planning Parity Owner', 'x'),
       ($2, 'planning-parity-other', 'planning-parity-other', 'Planning Parity Other', 'x')`,
      [OWNER_ID, OTHER_OWNER_ID]
    );

    conversations = new TypeOrmHomeConversationRepository(dataSource);
    projects = new TypeOrmProjectRepository(dataSource);
    tasks = new TypeOrmProjectTaskRepository(dataSource);
    ledger = new TypeOrmActionLedgerRepository(dataSource, new TypeOrmHomeActionEventRecorder());
    const taskMutations = new TaskMutationUseCases(ledger, tasks, tasks);
    const workspaceBoundary = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace', identityFile: '/workspace/.personal-ai-workspace-identity', expectedIdentity: 'integration-fixture'
    });
    const workspaces = new WorkspacePlanningUseCases(projects, projects, ledger, workspaceBoundary);
    const taskQuery = new GetGlobalTaskUseCase(tasks);
    changeProposals = new HomeChangeProposalUseCases(
      conversations, new TypeOrmHomeChangeProposalRepository(dataSource), taskQuery, taskMutations, workspaces, ledger
    );
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
      getTask: taskQuery,
      taskMutations,
      workspaces,
      undo: new ActionUndoUseCases(ledger, tasks, projects)
    });
    fileWorkspaceId = await createWorkspace(OWNER_ID, 'file-backed');
    dotWorkspaceId = await createWorkspace(OTHER_OWNER_ID, 'managed-workspace');
    await reconcileMappedOwners(dataSource, [OWNER_ID, OTHER_OWNER_ID], managedRoot, recoveryRoot);
  }, 120_000);

  afterAll(async () => {
    if (dataSource.isInitialized) {
      await dataSource.query('DROP TRIGGER IF EXISTS "home_parity_reject_action_receipt_trigger" ON "home_conversation_events"');
      await dataSource.query('DROP FUNCTION IF EXISTS "home_parity_reject_action_receipt"()');
      await dataSource.query('DELETE FROM "home_change_proposal_items" WHERE "owner_id" = ANY($1::uuid[])', [[OWNER_ID, OTHER_OWNER_ID]]);
      await removeFixtureRootsAndMappings(dataSource, [OWNER_ID, OTHER_OWNER_ID], managedRoot);
      await dataSource.query('DELETE FROM "users" WHERE "id" IN ($1, $2)', [OWNER_ID, OTHER_OWNER_ID]);
      await dataSource.destroy();
    }
    if (managedRoot) await fs.rm(managedRoot, { recursive: true, force: true });
    if (recoveryRoot) await fs.rm(recoveryRoot, { recursive: true, force: true });
  });

  it('uses canonical task/workspace commands with assistant receipts, scoped ownership, replay and undo', async () => {
    const ownerTurn = await createActiveHomeTurn(OWNER_ID, 'owner-command-parity');
    const otherTurn = await createActiveHomeTurn(OTHER_OWNER_ID, 'other-command-parity');

    const createRequest = {
      turn: ownerTurn, name: 'home_create_task', requestId: 'file-task-create',
      args: { title: 'Parity task file-backed', workspaceId: fileWorkspaceId, details: 'Synthetic task detail for the isolated integration test.' }
    } as const;
    const created = immediateData(await resolveCommand(createRequest));
    const replayed = immediateData(await resolveCommand(createRequest));
    expect(created.receipt).toMatchObject({ actionKind: 'task.create', targetKind: 'task', undoStatus: 'available' });
    expect(replayed).toMatchObject({ replayed: true, receipt: { id: created.receipt.id, targetId: created.receipt.targetId } });

    const update = immediateData(await resolveCommand({
      turn: ownerTurn, name: 'home_update_task', requestId: 'file-task-update',
      args: { taskId: created.receipt.targetId, expectedVersion: 1, details: 'Updated synthetic detail.' }
    }));
    expect(update.receipt.actionKind).toBe('task.update');

    const moveRequest = {
      turn: ownerTurn, name: 'home_move_task', requestId: 'file-task-move-to-inbox',
      args: { taskId: created.receipt.targetId, expectedVersion: 2, workspaceId: null }
    } as const;
    const moved = immediateData(await resolveCommand(moveRequest));
    expect(moved.receipt.actionKind).toBe('task.move');
    expect(immediateData(await resolveCommand(moveRequest))).toMatchObject({ replayed: true, receipt: { id: moved.receipt.id } });

    const inboxOrderRows: readonly { version: number | string }[] = await dataSource.query(
      'SELECT "version" FROM "project_task_order_states" WHERE "owner_id" = $1 AND "project_id" IS NULL', [OWNER_ID]
    );
    const inboxOrderVersion = Number(inboxOrderRows[0]?.version);
    expect(inboxOrderVersion).toBeGreaterThan(1);
    await expect(resolveCommand({
      turn: ownerTurn, name: 'home_archive_task', requestId: 'file-task-archive-stale-order',
      args: { taskId: created.receipt.targetId, expectedVersion: 3, expectedOrderVersion: inboxOrderVersion - 1 }
    })).rejects.toBeInstanceOf(ProjectTaskOrderConflictError);

    const archiveRequest = {
      turn: ownerTurn, name: 'home_archive_task', requestId: 'file-task-archive',
      args: { taskId: created.receipt.targetId, expectedVersion: 3, expectedOrderVersion: inboxOrderVersion }
    } as const;
    const archived = immediateData(await resolveCommand(archiveRequest));
    expect(archived.receipt.actionKind).toBe('task.archive');
    const archivedReplay = immediateData(await resolveCommand(archiveRequest));
    expect(archivedReplay).toMatchObject({ replayed: true, receipt: { id: archived.receipt.id, targetId: created.receipt.targetId } });
    await expect(resolveCommand({ ...archiveRequest, args: { ...archiveRequest.args, expectedOrderVersion: inboxOrderVersion + 1 } }))
      .rejects.toBeInstanceOf(ProjectTaskIdempotencyReusedError);
    const inboxOrderAfterArchive: readonly { version: number | string }[] = await dataSource.query(
      'SELECT "version" FROM "project_task_order_states" WHERE "owner_id" = $1 AND "project_id" IS NULL', [OWNER_ID]
    );
    const currentInboxOrderVersion = Number(inboxOrderAfterArchive[0]?.version);
    expect(currentInboxOrderVersion).toBe(inboxOrderVersion + 1);
    await expect(resolveCommand({
      ...archiveRequest, requestId: 'file-task-archive-different-operation',
      args: { ...archiveRequest.args, expectedOrderVersion: currentInboxOrderVersion }
    }))
      .rejects.toBeInstanceOf(ProjectTaskArchivedError);
    const undoArchiveRequest = {
      turn: ownerTurn, name: 'home_undo_action', requestId: 'file-task-undo-archive', args: { actionId: archived.receipt.id }
    } as const;
    const undoneArchive = immediateData(await resolveCommand(undoArchiveRequest));
    expect(undoneArchive.receipt.actionKind).toBe('undo');
    expect(immediateData(await resolveCommand(undoArchiveRequest))).toMatchObject({ replayed: true, receipt: { id: undoneArchive.receipt.id } });

    const rootless = immediateData(await resolveCommand({
      turn: ownerTurn, name: 'home_create_workspace', requestId: 'rootless-workspace-create',
      args: { name: 'Parity Rootless Workspace', objective: 'Initial synthetic objective.' }
    }));
    expect(rootless.receipt).toMatchObject({ actionKind: 'workspace.create', targetKind: 'workspace' });
    const rootlessWorkspaceId = rootless.receipt.targetId;
    const updatedWorkspace = immediateData(await resolveCommand({
      turn: ownerTurn, name: 'home_update_workspace_objective', requestId: 'rootless-workspace-objective',
      args: { workspaceId: rootlessWorkspaceId, expectedVersion: 1, objective: 'Updated synthetic objective.' }
    }));
    expect(updatedWorkspace.receipt.actionKind).toBe('workspace.update');
    const undoneWorkspace = immediateData(await resolveCommand({
      turn: ownerTurn, name: 'home_undo_action', requestId: 'rootless-workspace-undo-objective', args: { actionId: updatedWorkspace.receipt.id }
    }));
    expect(undoneWorkspace.receipt.actionKind).toBe('undo');

    const dotTask = immediateData(await resolveCommand({
      turn: otherTurn, name: 'home_create_task', requestId: 'dot-root-task-create',
      args: { title: 'Parity task dot-root', workspaceId: dotWorkspaceId }
    }));
    expect(dotTask.receipt).toMatchObject({ actionKind: 'task.create', targetKind: 'task' });

    await expect(resolveCommand({
      turn: ownerTurn, name: 'home_create_task', requestId: 'foreign-workspace-denied',
      args: { title: 'Must not cross owner boundary', workspaceId: dotWorkspaceId }
    })).rejects.toBeInstanceOf(ProjectNotFoundError);

    const persistedTasks: readonly { id: string; owner_id: string; project_id: string | null; status: string; archived_at: string | null; details: string | null }[] = await dataSource.query(
      `SELECT "id", "owner_id", "project_id", "status", "archived_at", "details" FROM "project_tasks" WHERE "id" = ANY($1::uuid[])`,
      [[created.receipt.targetId, dotTask.receipt.targetId]]
    );
    expect(persistedTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.receipt.targetId, owner_id: OWNER_ID, project_id: null, status: 'todo', archived_at: null, details: 'Updated synthetic detail.' }),
      expect.objectContaining({ id: dotTask.receipt.targetId, owner_id: OTHER_OWNER_ID, project_id: dotWorkspaceId })
    ]));

    const workspaceRows: readonly { id: string; owner_id: string; relative_root: string | null; relative_root_key: string | null; objective: string | null }[] = await dataSource.query(
      `SELECT "id", "owner_id", "relative_root", "relative_root_key", "objective" FROM "projects" WHERE "id" = $1`, [rootlessWorkspaceId]
    );
    expect(workspaceRows[0]).toMatchObject({ id: rootlessWorkspaceId, owner_id: OWNER_ID, relative_root: null, relative_root_key: null, objective: 'Initial synthetic objective.' });

    const receipts: readonly { action_kind: string; actor_kind: string; turn_id: string; target_id: string }[] = await dataSource.query(
      `SELECT "action_kind", "actor_kind", "turn_id", "target_id" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "turn_id" = $2`,
      [OWNER_ID, ownerTurn.turnId]
    );
    expect(receipts).toHaveLength(8);
    expect(receipts.every((row) => row.actor_kind === 'assistant' && row.turn_id === ownerTurn.turnId)).toBe(true);
    expect(new Set(receipts.map((row) => row.action_kind))).toEqual(new Set(['task.create', 'task.update', 'task.move', 'task.archive', 'undo', 'workspace.create', 'workspace.update']));

    const eventPage = await conversations.listEventsForOwner({ ownerId: OWNER_ID, conversationId: ownerTurn.conversationId, afterSequence: 0, limit: 50 });
    const actionEvents = eventPage?.events.filter((event) => event.type === 'action.receipt') ?? [];
    expect(actionEvents).toHaveLength(8);
    expect(actionEvents.filter((event) => event.entityId === created.receipt.id)).toHaveLength(1);
    expect(actionEvents.filter((event) => event.entityId === archived.receipt.id)).toHaveLength(1);
    expect(actionEvents.every((event) => event.turnId === ownerTurn.turnId)).toBe(true);
    expect(JSON.stringify(actionEvents)).not.toContain('synthetic detail');

    const dotReceipts: readonly { action_kind: string; actor_kind: string; turn_id: string }[] = await dataSource.query(
      'SELECT "action_kind", "actor_kind", "turn_id" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "turn_id" = $2',
      [OTHER_OWNER_ID, otherTurn.turnId]
    );
    const dotEvents = await conversations.listEventsForOwner({ ownerId: OTHER_OWNER_ID, conversationId: otherTurn.conversationId, afterSequence: 0, limit: 20 });
    expect(dotReceipts).toEqual([{ action_kind: 'task.create', actor_kind: 'assistant', turn_id: otherTurn.turnId }]);
    expect(dotEvents?.events.filter((event) => event.type === 'action.receipt').map((event) => event.entityId)).toEqual([dotTask.receipt.id]);

    const ownerRows: readonly { count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS "count" FROM "project_tasks" WHERE "owner_id" = $1 AND "title" = $2',
      [OWNER_ID, 'Must not cross owner boundary']
    );
    expect(Number(ownerRows[0]?.count)).toBe(0);
  });

  it('rolls back a task write and action receipt together when the Home receipt event fails', async () => {
    const turn = await createActiveHomeTurn(OWNER_ID, 'command-parity-atomicity');
    await dataSource.query(`
      CREATE FUNCTION "home_parity_reject_action_receipt"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."event_type" = 'action.receipt' THEN
          RAISE EXCEPTION 'intentional isolated action receipt rollback check';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await dataSource.query(`CREATE TRIGGER "home_parity_reject_action_receipt_trigger" BEFORE INSERT ON "home_conversation_events" FOR EACH ROW EXECUTE FUNCTION "home_parity_reject_action_receipt"()`);
    try {
      await expect(resolveCommand({
        turn, name: 'home_create_task', requestId: 'atomic-task-create',
        args: { title: 'Atomic rollback sentinel', workspaceId: null }
      })).rejects.toThrow('intentional isolated action receipt rollback check');
    } finally {
      await dataSource.query('DROP TRIGGER IF EXISTS "home_parity_reject_action_receipt_trigger" ON "home_conversation_events"');
      await dataSource.query('DROP FUNCTION IF EXISTS "home_parity_reject_action_receipt"()');
    }

    const taskRows: readonly { count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS "count" FROM "project_tasks" WHERE "owner_id" = $1 AND "title" = $2',
      [OWNER_ID, 'Atomic rollback sentinel']
    );
    const receiptRows: readonly { count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS "count" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "turn_id" = $2',
      [OWNER_ID, turn.turnId]
    );
    const eventPage = await conversations.listEventsForOwner({ ownerId: OWNER_ID, conversationId: turn.conversationId, afterSequence: 0, limit: 20 });
    expect(Number(taskRows[0]?.count)).toBe(0);
    expect(Number(receiptRows[0]?.count)).toBe(0);
    expect(eventPage?.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(eventPage?.events.some((event) => event.type === 'action.receipt')).toBe(false);
  });

  it('defaults direct task creation to the persisted workspace and blocks bulk proposals without side effects', async () => {
    const homeTurn = await createActiveHomeTurn(OWNER_ID, 'workspace-create-defaults-home');
    const selectedWorkspace = immediateData(await resolveCommand({
      turn: homeTurn, name: 'home_create_workspace', requestId: 'workspace-create-defaults-selected',
      args: { name: 'Selected rootless workspace' }
    })).receipt.targetId;
    const otherWorkspace = immediateData(await resolveCommand({
      turn: homeTurn, name: 'home_create_workspace', requestId: 'workspace-create-defaults-other',
      args: { name: 'Other rootless workspace' }
    })).receipt.targetId;
    const workspaceTurn = await createActiveWorkspaceTurn(OWNER_ID, selectedWorkspace, 'workspace-create-defaults-turn');

    const direct = immediateData(await resolveCommand({
      turn: workspaceTurn, name: 'home_create_task', requestId: 'workspace-create-defaults-direct',
      args: { title: 'Workspace scoped direct create' }
    }));
    await expect(resolveCommand({
      turn: workspaceTurn, name: 'home_create_task', requestId: 'workspace-create-defaults-direct-null',
      args: { title: 'Denied direct null create', workspaceId: null }
    })).rejects.toBeInstanceOf(HomePlanningScopeConflictError);
    await expect(resolveCommand({
      turn: workspaceTurn, name: 'home_create_task', requestId: 'workspace-create-defaults-direct-other',
      args: { title: 'Denied direct other workspace', workspaceId: otherWorkspace }
    })).rejects.toBeInstanceOf(HomePlanningScopeConflictError);

    const draftResolution = await resolveCommand({
      turn: workspaceTurn, name: 'home_propose_bulk_changes', requestId: 'workspace-create-defaults-bulk',
      args: { items: [
        { action: 'task.create', title: 'Workspace scoped bulk create one' },
        { action: 'task.create', title: 'Workspace scoped bulk create two' }
      ] }
    });
    expect(draftResolution).toBeNull();
    expect((await changeProposals.list({ ownerId: OWNER_ID, conversationId: workspaceTurn.conversationId, limit: 20 })).proposals).toEqual([]);

    await expect(resolveCommand({
      turn: workspaceTurn, name: 'home_propose_bulk_changes', requestId: 'workspace-create-defaults-bulk-null',
      args: { items: [
        { action: 'task.create', title: 'Denied bulk null create', workspaceId: null },
        { action: 'task.create', title: 'Denied bulk null create two', workspaceId: null }
      ] }
    })).resolves.toBeNull();
    await expect(resolveCommand({
      turn: workspaceTurn, name: 'home_propose_bulk_changes', requestId: 'workspace-create-defaults-bulk-other',
      args: { items: [
        { action: 'task.create', title: 'Denied bulk other workspace', workspaceId: otherWorkspace },
        { action: 'task.create', title: 'Denied bulk other workspace two', workspaceId: otherWorkspace }
      ] }
    })).resolves.toBeNull();

    const inbox = immediateData(await resolveCommand({
      turn: homeTurn, name: 'home_create_task', requestId: 'workspace-create-defaults-home-inbox',
      args: { title: 'Home omitted create stays in Inbox' }
    }));
    const taskRows: readonly { title: string; project_id: string | null }[] = await dataSource.query(
      'SELECT "title", "project_id" FROM "project_tasks" WHERE "owner_id" = $1 AND "title" = ANY($2::text[])',
      [OWNER_ID, [
        'Workspace scoped direct create',
        'Denied direct null create', 'Denied direct other workspace', 'Denied bulk null create',
        'Denied bulk null create two', 'Denied bulk other workspace', 'Denied bulk other workspace two',
        'Home omitted create stays in Inbox'
      ]]
    );
    expect(taskRows).toHaveLength(2);
    expect(taskRows.find((row) => row.title === 'Workspace scoped direct create')?.project_id).toBe(selectedWorkspace);
    expect(taskRows.find((row) => row.title === 'Home omitted create stays in Inbox')?.project_id).toBeNull();

    expect(inbox.receipt.targetKind).toBe('task');
    expect(direct.receipt.targetKind).toBe('task');
  });

  it('replays an existing archive receipt after workspace archival but rejects a fresh write', async () => {
    const turn = await createActiveHomeTurn(OWNER_ID, 'archive-replay-archived-workspace');
    const workspace = immediateData(await resolveCommand({
      turn, name: 'home_create_workspace', requestId: 'archive-replay-workspace-create',
      args: { name: 'Archive replay workspace', objective: 'Isolated test fixture.' }
    }));
    const workspaceId = workspace.receipt.targetId;
    const alreadyArchivedTarget = immediateData(await resolveCommand({
      turn, name: 'home_create_task', requestId: 'archive-replay-target-create',
      args: { title: 'Archive replay target', workspaceId }
    }));
    const freshTarget = immediateData(await resolveCommand({
      turn, name: 'home_create_task', requestId: 'archive-replay-fresh-target-create',
      args: { title: 'Fresh archive target', workspaceId }
    }));
    const orderRows: readonly { version: number | string }[] = await dataSource.query(
      'SELECT "version" FROM "project_task_order_states" WHERE "owner_id" = $1 AND "project_id" = $2', [OWNER_ID, workspaceId]
    );
    const orderVersion = Number(orderRows[0]?.version);
    const archiveRequest = {
      turn, name: 'home_archive_task', requestId: 'archive-replay-target-archive',
      args: { taskId: alreadyArchivedTarget.receipt.targetId, expectedVersion: 1, expectedOrderVersion: orderVersion }
    } as const;
    const archivedReceipt = immediateData(await resolveCommand(archiveRequest));
    await dataSource.query('UPDATE "projects" SET "status" = \'archived\' WHERE "owner_id" = $1 AND "id" = $2', [OWNER_ID, workspaceId]);

    const replayed = immediateData(await resolveCommand(archiveRequest));
    expect(replayed).toMatchObject({ replayed: true, receipt: { id: archivedReceipt.receipt.id } });
    await expect(resolveCommand({
      turn, name: 'home_archive_task', requestId: 'archive-replay-fresh-target-archive',
      args: { taskId: freshTarget.receipt.targetId, expectedVersion: 1, expectedOrderVersion: orderVersion }
    })).rejects.toBeInstanceOf(ProjectTaskArchivedProjectError);

    const receipts: readonly { action_kind: string; target_id: string }[] = await dataSource.query(
      'SELECT "action_kind", "target_id" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "turn_id" = $2 ORDER BY "action_kind", "target_id"',
      [OWNER_ID, turn.turnId]
    );
    expect(receipts).toHaveLength(4);
    expect(receipts.filter((record) => record.action_kind === 'task.archive' && record.target_id === alreadyArchivedTarget.receipt.targetId)).toHaveLength(1);
    const events = await conversations.listEventsForOwner({ ownerId: OWNER_ID, conversationId: turn.conversationId, afterSequence: 0, limit: 20 });
    expect(events?.events.filter((event) => event.type === 'action.receipt')).toHaveLength(4);
    expect(events?.events.filter((event) => event.entityId === archivedReceipt.receipt.id)).toHaveLength(1);
    const freshRows: readonly { status: string }[] = await dataSource.query(
      'SELECT "status" FROM "project_tasks" WHERE "owner_id" = $1 AND "id" = $2', [OWNER_ID, freshTarget.receipt.targetId]
    );
    expect(freshRows[0]?.status).toBe('todo');
  });

  async function createActiveHomeTurn(ownerId: string, key: string) {
    return createActiveTurn(ownerId, key, { kind: 'home' });
  }

  async function createActiveWorkspaceTurn(ownerId: string, workspaceId: string, key: string) {
    return createActiveTurn(ownerId, key, { kind: 'workspace', workspaceId });
  }

  async function createActiveTurn(ownerId: string, key: string, scope: HomeConversationScope) {
    const conversation = (await conversations.create({
      ownerId, scope, title: `Planning parity ${key}`, requestKey: `${key}-conversation`, requestFingerprint: `${key}-conversation-fingerprint`
    })).resource;
    const submission = await conversations.submitTurn({
      ownerId, conversationId: conversation.id, requestKey: `${key}-submit`, requestFingerprint: `${key}-submit-fingerprint`,
      message: 'Synthetic command parity turn.', initialStatus: 'pending', homePolicyRevision: '1',
      workspacePolicyRevision: scope.kind === 'workspace' ? '1' : null
    });
    const running = await conversations.updateTurnStatus({ ownerId, conversationId: conversation.id, turnId: submission.turn.id, status: 'running' });
    if (!running) throw new Error('The Home command parity fixture turn did not enter running state.');
    return { ownerId, conversationId: conversation.id, turnId: running.id, scope };
  }

  async function resolveCommand(input: {
    readonly turn: { readonly ownerId: string; readonly conversationId: string; readonly turnId: string; readonly scope: HomeConversationScope };
    readonly name: string;
    readonly requestId: string;
    readonly args: Readonly<Record<string, unknown>>;
  }): Promise<HomePlanningToolResolution | null> {
    return handler.resolve({ ...input.turn, name: input.name, requestId: input.requestId, args: input.args });
  }

  async function createWorkspace(ownerId: string, slug: string): Promise<string> {
    const projectId = randomUUID();
    const relativeRoot = `projects/${projectId}`;
    const rootKey = relativeRoot.toLocaleLowerCase('en-US');
    await fs.mkdir(path.join(managedRoot, ownerId, ...relativeRoot.split('/')), { recursive: true });
    const rows: readonly { id: string }[] = await dataSource.query(
      `INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "status", "storage_kind")
       VALUES ($1, $2, $3, $4, $5, $6, 'active', 'managed') RETURNING "id"`,
      [projectId, ownerId, slug, slug, relativeRoot, rootKey]
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('The isolated workspace fixture was not created.');
    await dataSource.query(
      `INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
       VALUES ($1, $2, $2, $3, 'managed', $4, 'active')`,
      [ownerId, id, rootKey, relativeRoot]
    );
    return id;
  }
});

function immediateData(resolution: HomePlanningToolResolution | null): {
  readonly receipt: { readonly id: string; readonly actionKind: string; readonly targetKind: string; readonly targetId: string; readonly undoStatus: string };
  readonly replayed: boolean;
} {
  if (!resolution || resolution.kind !== 'immediate' || resolution.result.outcome !== 'shared') {
    throw new Error('The expected Home planning command did not return an applied receipt.');
  }
  const data = resolution.result.data;
  if (!isRecord(data.receipt) || typeof data.replayed !== 'boolean'
    || typeof data.receipt.id !== 'string' || typeof data.receipt.actionKind !== 'string'
    || typeof data.receipt.targetKind !== 'string' || typeof data.receipt.targetId !== 'string'
    || typeof data.receipt.undoStatus !== 'string') {
    throw new Error('The Home planning command returned a malformed receipt result.');
  }
  return {
    receipt: {
      id: data.receipt.id,
      actionKind: data.receipt.actionKind,
      targetKind: data.receipt.targetKind,
      targetId: data.receipt.targetId,
      undoStatus: data.receipt.undoStatus
    },
    replayed: data.replayed
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


async function reconcileMappedOwners(
  dataSource: DataSource,
  ownerIds: readonly string[],
  managedRoot: string,
  recoveryRoot: string
): Promise<void> {
  const quota = new TypeOrmStorageQuotaRepository(dataSource);
  const accounting = new TypeOrmStorageContentAccounting(dataSource, quota);
  const mappings = new TypeOrmStorageRootMappingRepository(dataSource);
  const scanner = new StorageQuotaRootScanner();
  for (const ownerId of ownerIds) {
    const ownerMappings = await mappings.listMappings(ownerId);
    const references = await scanDatabaseOwner(dataSource, accounting, ownerId);
    const fileReferences = await scanner.scan([
      ...await resolveFixtureRoots(dataSource, ownerId, ownerMappings, managedRoot),
      emptyRecoveryRoot(ownerId, recoveryRoot)
    ]);
    await quota.reconcileReferences(ownerId, [...references, ...fileReferences]);
  }
}

async function resolveFixtureRoots(
  dataSource: DataSource,
  ownerId: string,
  mappings: readonly StorageRootMapping[],
  managedRoot: string
): Promise<readonly TrustedStorageRoot[]> {
  const projects: readonly { id: string; relative_root: string; relative_root_key: string; storage_kind: 'legacy' | 'managed' | null }[] = await dataSource.query(
    'SELECT "id", "relative_root", "relative_root_key", "storage_kind" FROM "projects" WHERE "owner_id" = $1 AND "relative_root" IS NOT NULL',
    [ownerId]
  );
  if (projects.length !== mappings.length) throw new Error('Every rooted planning fixture must have an active root mapping.');
  return mappings.map((mapping) => {
    const project = projects.find((row) => row.id === mapping.projectId);
    if (!project || mapping.ownerId !== ownerId || mapping.state !== 'active' || mapping.storageKind !== 'managed'
      || mapping.relativeRoot !== project.relative_root || mapping.rootKey !== project.relative_root_key
      || mapping.storageKind !== project.storage_kind) {
      throw new Error('A planning fixture root mapping does not match its project row.');
    }
    return {
      ownerId,
      projectId: mapping.projectId,
      rootKey: mapping.rootKey,
      absolutePath: path.join(managedRoot, ownerId, ...mapping.relativeRoot.split('/')),
      classifyFile: () => 'project_file'
    };
  });
}

function emptyRecoveryRoot(ownerId: string, recoveryRoot: string): TrustedStorageRoot {
  return {
    ownerId,
    projectId: null,
    rootKey: 'recovery-v1',
    absolutePath: recoveryRoot,
    classifyFile: () => 'recovery_file',
    referenceForFile: () => null
  };
}

async function scanDatabaseOwner(
  dataSource: DataSource,
  accounting: TypeOrmStorageContentAccounting,
  ownerId: string
): Promise<readonly StorageResourceReference[]> {
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

async function removeFixtureRootsAndMappings(
  dataSource: DataSource,
  ownerIds: readonly string[],
  managedRoot: string
): Promise<void> {
  await removeDirectoryAndVerify(managedRoot);
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const reservations: readonly { count: string }[] = await runner.query(
      'SELECT COUNT(*)::text AS "count" FROM "storage_filesystem_reservations" WHERE "owner_id" = ANY($1::uuid[])', [ownerIds]
    );
    if (Number(reservations[0]?.count ?? '0') > 0) throw new Error('Planning fixture roots still have quota reservations at cleanup.');
    const mappings: readonly StorageRootMapping[] = await runner.query(
      `SELECT "owner_id" AS "ownerId", "project_id" AS "projectId", "locator_project_id" AS "locatorProjectId",
        "root_key" AS "rootKey", "storage_kind" AS "storageKind", "relative_root" AS "relativeRoot", "state"
       FROM "storage_root_mappings" WHERE "owner_id" = ANY($1::uuid[]) ORDER BY "owner_id", "root_key"`,
      [ownerIds]
    );
    const rootedProjects: readonly { readonly id: string; readonly owner_id: string; readonly relative_root: string; readonly relative_root_key: string }[] = await runner.query(
      'SELECT "id", "owner_id", "relative_root", "relative_root_key" FROM "projects" WHERE "owner_id" = ANY($1::uuid[]) AND "relative_root" IS NOT NULL',
      [ownerIds]
    );
    if (mappings.length !== rootedProjects.length || mappings.some((mapping) => {
      const project = rootedProjects.find((row) => row.id === mapping.projectId);
      return !project || mapping.state !== 'active' || mapping.ownerId !== project.owner_id || mapping.projectId !== mapping.locatorProjectId
        || mapping.storageKind !== 'managed' || mapping.relativeRoot !== project.relative_root
        || mapping.rootKey !== project.relative_root_key || mapping.relativeRoot !== `projects/${mapping.locatorProjectId}`;
    })) {
      throw new Error('Refusing to remove a planning root mapping that is not backed by this fixture’s managed project row.');
    }
    await runner.query('DELETE FROM "storage_resource_references" WHERE "owner_id" = ANY($1::uuid[])', [ownerIds]);
    await runner.query(
      `UPDATE "storage_root_mappings" SET "project_id" = NULL, "state" = 'retained'
       WHERE "owner_id" = ANY($1::uuid[]) AND "state" = 'active'`, [ownerIds]
    );
    for (const mapping of mappings) {
      await runner.query("SELECT set_config('app.storage_root_removal_verified', $1, true)", [`${mapping.ownerId}:${mapping.rootKey}`]);
      await runner.query('DELETE FROM "storage_root_mappings" WHERE "owner_id" = $1 AND "root_key" = $2', [mapping.ownerId, mapping.rootKey]);
    }
    await runner.commitTransaction();
  } catch (error: unknown) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

async function removeDirectoryAndVerify(directory: string): Promise<void> {
  if (!directory) return;
  await fs.rm(directory, { recursive: true, force: true });
  try {
    await fs.lstat(directory);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('A planning fixture root remained after its verified cleanup.');
}
