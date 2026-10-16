import type { DataSource } from 'typeorm';

import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmActionLedgerRepository } from '@/infrastructure/database/repositories/typeorm-action-ledger-repository';
import { TypeOrmHomeActionEventRecorder } from '@/infrastructure/database/repositories/typeorm-home-action-event-recorder';
import { TypeOrmHomeConversationRepository } from '@/infrastructure/database/repositories/typeorm-home-conversation-repository';
import { TypeOrmProjectRepository } from '@/infrastructure/database/repositories/typeorm-project-repository';
import { TypeOrmProjectTaskRepository } from '@/infrastructure/database/repositories/typeorm-project-task-repository';
import { WorkspaceBoundaryAdapter } from '@/infrastructure/workspace/workspace-boundary';
import { ActionUndoUseCases } from '@/modules/home-assistant/use-cases/action-undo-use-cases';
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
  let handler: HomePlanningToolRequestHandler;

  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    const migrations: readonly { name: string }[] = await dataSource.query('SELECT "name" FROM "migrations"');
    expect(migrations).toHaveLength(dataSource.migrations.length);
    expect(migrations.map((migration) => migration.name)).toContain('CreateHomeChangeProposals1710000025000');

    await dataSource.query('DELETE FROM "users" WHERE "id" IN ($1, $2)', [OWNER_ID, OTHER_OWNER_ID]);
    await dataSource.query(
      `INSERT INTO "users" ("id", "scope_key", "display_name", "password_hash") VALUES
       ($1, 'planning-parity-owner', 'Planning Parity Owner', 'x'),
       ($2, 'planning-parity-other', 'Planning Parity Other', 'x')`,
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
    handler = new HomePlanningToolRequestHandler({
      conversations,
      listTasks: new ListGlobalTasksUseCase(tasks),
      getTask: new GetGlobalTaskUseCase(tasks),
      taskMutations,
      workspaces,
      undo: new ActionUndoUseCases(ledger, tasks, projects),
      proposals: { createFromTool: async () => { throw new Error('Bulk proposals are outside this direct-command parity fixture.'); } }
    });
  }, 120_000);

  afterAll(async () => {
    if (dataSource.isInitialized) {
      await dataSource.query('DROP TRIGGER IF EXISTS "home_parity_reject_action_receipt_trigger" ON "home_conversation_events"');
      await dataSource.query('DROP FUNCTION IF EXISTS "home_parity_reject_action_receipt"()');
      await dataSource.query('DELETE FROM "users" WHERE "id" IN ($1, $2)', [OWNER_ID, OTHER_OWNER_ID]);
      await dataSource.destroy();
    }
  });

  it('uses canonical task/workspace commands with assistant receipts, scoped ownership, replay and undo', async () => {
    const fileWorkspaceId = await createWorkspace(OWNER_ID, 'file-backed', 'repo/home');
    const dotWorkspaceId = await createWorkspace(OTHER_OWNER_ID, 'dot-root', '.');
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
    const conversation = (await conversations.create({
      ownerId, scope: { kind: 'home' }, title: `Planning parity ${key}`, requestKey: `${key}-conversation`, requestFingerprint: `${key}-conversation-fingerprint`
    })).resource;
    const submission = await conversations.submitTurn({
      ownerId, conversationId: conversation.id, requestKey: `${key}-submit`, requestFingerprint: `${key}-submit-fingerprint`,
      message: 'Synthetic command parity turn.', initialStatus: 'pending'
    });
    const running = await conversations.updateTurnStatus({ ownerId, conversationId: conversation.id, turnId: submission.turn.id, status: 'running' });
    if (!running) throw new Error('The Home command parity fixture turn did not enter running state.');
    return { ownerId, conversationId: conversation.id, turnId: running.id };
  }

  async function resolveCommand(input: {
    readonly turn: { readonly ownerId: string; readonly conversationId: string; readonly turnId: string };
    readonly name: string;
    readonly requestId: string;
    readonly args: Readonly<Record<string, unknown>>;
  }): Promise<HomePlanningToolResolution | null> {
    return handler.resolve({ ...input.turn, scope: { kind: 'home' }, name: input.name, requestId: input.requestId, args: input.args });
  }

  async function createWorkspace(ownerId: string, slug: string, relativeRoot: string): Promise<string> {
    const rows: readonly { id: string }[] = await dataSource.query(
      `INSERT INTO "projects" ("owner_id", "name", "slug", "relative_root", "relative_root_key", "status")
       VALUES ($1, $2, $3, $4, $5, 'active') RETURNING "id"`,
      [ownerId, slug, slug, relativeRoot, relativeRoot.toLocaleLowerCase('en-US')]
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('The isolated workspace fixture was not created.');
    return id;
  }
});

function immediateData(resolution: HomePlanningToolResolution | null): {
  readonly receipt: { readonly id: string; readonly actionKind: string; readonly targetKind: string; readonly targetId: string; readonly undoStatus: string };
  readonly replayed: boolean;
} {
  if (!resolution || resolution.kind !== 'immediate') throw new Error('The expected Home planning command did not return an immediate receipt.');
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
