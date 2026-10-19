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
import { HomeConversationInputInvalidError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { HomeProposalRevisionConflictError } from '@/modules/home-assistant/domain/home-planning-errors';
import { ActionUndoUseCases } from '@/modules/home-assistant/use-cases/action-undo-use-cases';
import { HomeChangeProposalUseCases } from '@/modules/home-assistant/use-cases/home-change-proposal-use-cases';
import { HomePlanningToolRequestHandler } from '@/modules/home-assistant/use-cases/home-planning-tool-request-handler';
import { WorkspacePlanningUseCases } from '@/modules/projects/use-cases/workspace-planning-use-cases';
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
  let proposalUseCases: HomeChangeProposalUseCases;
  let concurrentSealBarrier: { readonly proposalId: string; arrivals: number; readonly promise: Promise<void>; readonly release: () => void } | null = null;
  let targetRevalidationBarrier: { readonly taskId: string; claimed: boolean; readonly promise: Promise<void>; readonly reached: Promise<void>; readonly signalReached: () => void; readonly release: () => void } | null = null;

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
    const workspaces = new WorkspacePlanningUseCases(projects, projects, ledger, workspaceBoundary);
    const repositoryWithLostCompletionResponse = new Proxy(proposals, {
      get(target, property, receiver) {
        if (property === 'seal') {
          return async (input: Parameters<TypeOrmHomeChangeProposalRepository['seal']>[0]) => {
            const barrier = concurrentSealBarrier;
            if (barrier?.proposalId === input.proposalId) {
              barrier.arrivals += 1;
              if (barrier.arrivals === 2) barrier.release();
              await barrier.promise;
            }
            return target.seal(input);
          };
        }
        if (property === 'updateExecutionState') {
          return async (input: Parameters<TypeOrmHomeChangeProposalRepository['updateExecutionState']>[0]) => {
            if (input.state === 'completed' && !lostCompletionResponse) {
              lostCompletionResponse = true;
              throw new Error('isolated response-loss simulation');
            }
            return target.updateExecutionState(input);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const proposalTaskQuery = new Proxy(new GetGlobalTaskUseCase(tasks), {
      get(target, property, receiver) {
        if (property === 'execute') {
          return async (input: Parameters<GetGlobalTaskUseCase['execute']>[0]) => {
            const barrier = targetRevalidationBarrier;
            if (barrier?.taskId === input.taskId && !barrier.claimed) {
              barrier.claimed = true;
              barrier.signalReached();
              await barrier.promise;
            }
            return target.execute(input);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    proposalUseCases = new HomeChangeProposalUseCases(
      conversations, repositoryWithLostCompletionResponse, proposalTaskQuery, taskMutations, workspaces, ledger
    );
    handler = new HomePlanningToolRequestHandler({
      principalAuthorization: { assertActive: async () => undefined },
      conversations,
      listTasks: new ListGlobalTasksUseCase(tasks),
      getTask: new GetGlobalTaskUseCase(tasks),
      taskMutations,
      workspaces,
      undo: new ActionUndoUseCases(ledger, tasks, projects),
      proposals: proposalUseCases
    });
    await reconcileRootlessOwner(dataSource, OWNER_ID);
  }, 120_000);

  let lostCompletionResponse = false;

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

  it('seals and executes canonical items for a completed source turn, then explicitly resumes without duplicate receipts', async () => {
    const conversation = (await conversations.create({
      ownerId: OWNER_ID, scope: { kind: 'home' }, title: 'Synthetic proposal execution',
      requestKey: 'proposal-execution-conversation', requestFingerprint: 'proposal-execution-conversation-fingerprint'
    })).resource;
    const submitted = await conversations.submitTurn({
      ownerId: OWNER_ID, conversationId: conversation.id, requestKey: 'proposal-execution-turn',
      requestFingerprint: 'proposal-execution-turn-fingerprint', message: 'Create one synthetic planning workspace and task.', initialStatus: 'pending'
    });
    const runningTurn = await conversations.updateTurnStatus({
      ownerId: OWNER_ID, conversationId: conversation.id, turnId: submitted.turn.id, status: 'running'
    });
    if (!runningTurn) throw new Error('The synthetic proposal turn did not enter running state.');

    const resolution = await handler.resolve({
      ownerId: OWNER_ID, conversationId: conversation.id, turnId: runningTurn.id, scope: { kind: 'home' },
      requestId: 'bulk-proposal-request', name: 'home_propose_bulk_changes', args: {
        items: [
          { action: 'workspace.create', name: 'Synthetic accepted workspace', objective: 'Isolated test only.' },
          { action: 'task.create', title: 'Synthetic accepted task', workspaceId: { workspaceRef: 1 }, importance: 'medium', deadline: { kind: 'days_from_today', days: 1 } }
        ]
      }
    });
    expect(resolution).toEqual({ kind: 'immediate', result: { outcome: 'shared', data: {
      proposal: expect.objectContaining({ state: 'review_required', revision: 1, itemCount: 2 }),
      execution: { state: 'proposal_saved' }
    } } });
    const draft = await proposals.findRequest(OWNER_ID, runningTurn.id, 'bulk-proposal-request');
    expect(draft).toMatchObject({ state: 'review_required', itemCount: 2, items: [
      { position: 0, action: 'workspace.create', state: 'ready' },
      { position: 1, action: 'task.create', state: 'ready', command: { deadline: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) }, deadlineResolution: { timeZone: 'UTC', source: 'utc-fallback' } }
    ] });
    expect(JSON.stringify(draft)).not.toContain('/workspace');
    await expect(proposalUseCases.removeItem({
      ownerId: OWNER_ID, conversationId: conversation.id, proposalId: draft!.id,
      itemId: draft!.items[0]!.id, expectedRevision: draft!.revision
    })).rejects.toMatchObject({ code: 'HOME_PROPOSAL_DEPENDENCY_CONFLICT' });

    const cancellationAck = await handler.resolve({
      ownerId: OWNER_ID, conversationId: conversation.id, turnId: runningTurn.id, scope: { kind: 'home' },
      requestId: 'cancelable-proposal-request', name: 'home_propose_bulk_changes', args: {
        items: [
          { action: 'task.create', title: 'Editable synthetic task A', deadline: { kind: 'days_from_today', days: 1 } },
          { action: 'task.create', title: 'Removable synthetic task B' }
        ]
      }
    });
    expect(cancellationAck?.kind).toBe('immediate');
    const cancelable = await proposals.findRequest(OWNER_ID, runningTurn.id, 'cancelable-proposal-request');
    if (!cancelable) throw new Error('The synthetic editable proposal was not persisted.');
    expect(cancelable.items[0]?.deadlineResolution).toEqual({ timeZone: 'UTC', source: 'utc-fallback' });
    await expect(proposalUseCases.editItem({
      ownerId: OWNER_ID, conversationId: conversation.id, proposalId: cancelable.id,
      itemId: cancelable.items[0]!.id, expectedRevision: cancelable.revision,
      changes: { deadlineResolution: { timeZone: 'Pacific/Honolulu', source: 'configured' } }
    })).rejects.toBeInstanceOf(HomeConversationInputInvalidError);
    const edited = await proposalUseCases.editItem({
      ownerId: OWNER_ID, conversationId: conversation.id, proposalId: cancelable.id,
      itemId: cancelable.items[0]!.id, expectedRevision: cancelable.revision, changes: { title: 'Edited synthetic task A' }
    });
    expect(edited).toMatchObject({ revision: 2, items: [
      { command: { title: 'Edited synthetic task A' }, deadlineResolution: { timeZone: 'UTC', source: 'utc-fallback' } }, { command: { title: 'Removable synthetic task B' } }
    ] });
    const editedExactDate = await proposalUseCases.editItem({
      ownerId: OWNER_ID, conversationId: conversation.id, proposalId: cancelable.id,
      itemId: cancelable.items[0]!.id, expectedRevision: edited.revision, changes: { deadline: '2026-10-20' }
    });
    expect(editedExactDate).toMatchObject({ revision: 3, items: [
      { command: { deadline: '2026-10-20' }, deadlineResolution: null }, { command: { title: 'Removable synthetic task B' } }
    ] });
    await dataSource.query(
      `UPDATE "home_change_proposal_items" SET "command" = "command"->'command'
       WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "proposal_id" = $3 AND "id" = $4`,
      [OWNER_ID, conversation.id, cancelable.id, cancelable.items[0]!.id]
    );
    const legacyRead = await proposals.getForOwner(OWNER_ID, conversation.id, cancelable.id);
    expect(legacyRead?.items[0]).toMatchObject({ command: { deadline: '2026-10-20' }, deadlineResolution: null });
    await expect(proposalUseCases.editItem({
      ownerId: OWNER_ID, conversationId: conversation.id, proposalId: cancelable.id,
      itemId: cancelable.items[0]!.id, expectedRevision: 1, changes: { title: 'Stale edit must fail' }
    })).rejects.toBeInstanceOf(HomeProposalRevisionConflictError);
    const reduced = await proposalUseCases.removeItem({
      ownerId: OWNER_ID, conversationId: conversation.id, proposalId: cancelable.id,
      itemId: cancelable.items[1]!.id, expectedRevision: editedExactDate.revision
    });
    expect(reduced).toMatchObject({ revision: 4, itemCount: 1, items: [{ command: { title: 'Edited synthetic task A', deadline: '2026-10-20' }, deadlineResolution: null }] });
    const cancelled = await proposalUseCases.cancel({
      ownerId: OWNER_ID, conversationId: conversation.id, proposalId: cancelable.id, expectedRevision: reduced.revision
    });
    expect(cancelled).toMatchObject({ state: 'cancelled', items: [{ state: 'cancelled' }] });

    const completedTurn = await conversations.completeTurnWithAssistant({
      ownerId: OWNER_ID, conversationId: conversation.id, turnId: runningTurn.id, content: 'Saved a two-item proposal for your review.', status: 'completed'
    });
    expect(completedTurn?.status).toBe('completed');

    let releaseConcurrentSeal!: () => void;
    const bothAtSeal = new Promise<void>((resolve) => { releaseConcurrentSeal = resolve; });
    concurrentSealBarrier = { proposalId: draft!.id, arrivals: 0, promise: bothAtSeal, release: releaseConcurrentSeal };
    const concurrentAcceptances = await Promise.allSettled([
      proposalUseCases.accept({ ownerId: OWNER_ID, conversationId: conversation.id, proposalId: draft!.id, expectedRevision: draft!.revision }),
      proposalUseCases.accept({ ownerId: OWNER_ID, conversationId: conversation.id, proposalId: draft!.id, expectedRevision: draft!.revision })
    ]);
    const concurrentSealArrivals = concurrentSealBarrier.arrivals;
    concurrentSealBarrier = null;
    expect(concurrentSealArrivals).toBe(2);
    const acceptanceFailures = concurrentAcceptances.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    const acceptanceReplays = concurrentAcceptances.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<HomeChangeProposalUseCases['accept']>>> => result.status === 'fulfilled');
    expect(acceptanceFailures).toHaveLength(1);
    expect(String(acceptanceFailures[0]?.reason)).toContain('isolated response-loss simulation');
    expect(acceptanceReplays).toHaveLength(1);
    expect(acceptanceReplays[0]?.value.replayed).toBe(true);

    const afterLostResponse = await proposals.getForOwner(OWNER_ID, conversation.id, draft!.id);
    expect(acceptanceReplays[0]?.value.proposal.acceptanceId).toBe(afterLostResponse?.acceptanceId);
    expect(afterLostResponse?.acceptanceId).not.toBeNull();
    expect(afterLostResponse).toMatchObject({ state: 'executing', items: [
      { action: 'workspace.create', state: 'saved' }, { action: 'task.create', state: 'saved', deadlineResolution: { timeZone: 'UTC', source: 'utc-fallback' } }
    ] });
    const receiptCountAfterFirstAttempt: readonly { count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS "count" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "turn_id" = $2',
      [OWNER_ID, runningTurn.id]
    );
    expect(Number(receiptCountAfterFirstAttempt[0]?.count)).toBe(2);

    const resumed = await proposalUseCases.execute({ ownerId: OWNER_ID, conversationId: conversation.id, proposalId: draft!.id });
    expect(resumed).toMatchObject({ replayed: true, proposal: { state: 'completed' }, execution: { state: 'completed' } });
    const repeatedAcceptance = await proposalUseCases.accept({ ownerId: OWNER_ID, conversationId: conversation.id, proposalId: draft!.id, expectedRevision: draft!.revision });
    expect(repeatedAcceptance).toMatchObject({ replayed: true, proposal: { state: 'completed' }, execution: { state: 'completed' } });
    await expect(proposalUseCases.accept({ ownerId: OWNER_ID, conversationId: conversation.id, proposalId: draft!.id, expectedRevision: draft!.revision + 1 }))
      .rejects.toBeInstanceOf(HomeProposalRevisionConflictError);
    const receiptRows: readonly { action_kind: string; actor_kind: string; turn_id: string; target_id: string }[] = await dataSource.query(
      'SELECT "action_kind", "actor_kind", "turn_id", "target_id" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "turn_id" = $2 ORDER BY "action_kind"',
      [OWNER_ID, runningTurn.id]
    );
    expect(receiptRows).toHaveLength(2);
    expect(receiptRows.every((row) => row.actor_kind === 'assistant' && row.turn_id === runningTurn.id)).toBe(true);
    expect(new Set(receiptRows.map((row) => row.action_kind))).toEqual(new Set(['task.create', 'workspace.create']));
    expect((await proposals.getForOwner(OWNER_ID, conversation.id, draft!.id))?.items.map((item) => item.state)).toEqual(['saved', 'saved']);

    const eventPage = await conversations.listEventsForOwner({ ownerId: OWNER_ID, conversationId: conversation.id, afterSequence: 0, limit: 50 });
    const actionEvents = eventPage?.events.filter((event) => event.type === 'action.receipt') ?? [];
    const proposalEvents = eventPage?.events.filter((event) => event.type.startsWith('proposal.')) ?? [];
    expect(actionEvents).toHaveLength(2);
    expect(actionEvents.every((event) => event.turnId === runningTurn.id)).toBe(true);
    expect(proposalEvents.some((event) => event.type === 'proposal.accepted')).toBe(true);
    const itemEvents = proposalEvents.filter((event) => event.type === 'proposal.item_status_changed');
    expect(itemEvents).toHaveLength(4);
    expect(itemEvents.filter((event) => event.payload.itemState === 'executing')).toHaveLength(2);
    expect(itemEvents.filter((event) => event.payload.itemState === 'saved')).toHaveLength(2);
    expect(JSON.stringify(eventPage?.events)).not.toContain('Synthetic accepted task');

    const taskRows: readonly { id: string; owner_id: string; project_id: string; title: string }[] = await dataSource.query(
      `SELECT t."id", t."owner_id", t."project_id", t."title" FROM "project_tasks" t
       JOIN "home_change_proposal_items" i ON i."target_id" = t."id"
       WHERE i."owner_id" = $1 AND i."proposal_id" = $2 AND i."action_kind" = 'task.create'`,
      [OWNER_ID, draft!.id]
    );
    expect(taskRows).toHaveLength(1);
    const workspaceRows: readonly { id: string; owner_id: string; relative_root: string | null; objective: string | null }[] = await dataSource.query(
      `SELECT p."id", p."owner_id", p."relative_root", p."objective" FROM "projects" p
       JOIN "home_change_proposal_items" i ON i."target_id" = p."id"
       WHERE i."owner_id" = $1 AND i."proposal_id" = $2 AND i."action_kind" = 'workspace.create'`,
      [OWNER_ID, draft!.id]
    );
    expect(workspaceRows).toHaveLength(1);
    expect(workspaceRows[0]).toMatchObject({ owner_id: OWNER_ID, relative_root: null, objective: 'Isolated test only.' });
    expect(taskRows[0]?.project_id).toBe(workspaceRows[0]?.id);
  }, 120_000);

  it('replays a same-revision acceptance when delayed target revalidation observes the winner’s write', async () => {
    lostCompletionResponse = true;
    const conversation = (await conversations.create({
      ownerId: OWNER_ID, scope: { kind: 'home' }, title: 'Acceptance revalidation race',
      requestKey: 'acceptance-revalidation-race-conversation', requestFingerprint: 'acceptance-revalidation-race-conversation-fingerprint'
    })).resource;
    const submitted = await conversations.submitTurn({
      ownerId: OWNER_ID, conversationId: conversation.id, requestKey: 'acceptance-revalidation-race-turn',
      requestFingerprint: 'acceptance-revalidation-race-turn-fingerprint', message: 'Create and update one synthetic task.', initialStatus: 'pending'
    });
    const runningTurn = await conversations.updateTurnStatus({
      ownerId: OWNER_ID, conversationId: conversation.id, turnId: submitted.turn.id, status: 'running'
    });
    if (!runningTurn) throw new Error('The synthetic acceptance race turn did not enter running state.');

    const created = await handler.resolve({
      ownerId: OWNER_ID, conversationId: conversation.id, turnId: runningTurn.id, scope: { kind: 'home' },
      requestId: 'acceptance-revalidation-race-create', name: 'home_create_task', args: { title: 'Versioned acceptance target' }
    });
    if (created?.kind !== 'immediate') throw new Error('The synthetic target task was not created.');
    const createdReceipt = created.result.data.receipt;
    if (!createdReceipt || typeof createdReceipt !== 'object' || !('targetId' in createdReceipt) || typeof createdReceipt.targetId !== 'string') {
      throw new Error('The synthetic target task receipt did not include its task ID.');
    }
    const taskId = createdReceipt.targetId;
    const saved = await handler.resolve({
      ownerId: OWNER_ID, conversationId: conversation.id, turnId: runningTurn.id, scope: { kind: 'home' },
      requestId: 'acceptance-revalidation-race-proposal', name: 'home_propose_bulk_changes', args: {
        items: [
          { action: 'task.update', taskId, expectedVersion: 1, status: 'in_progress' },
          { action: 'task.create', title: 'Second accepted race item' }
        ]
      }
    });
    if (saved?.kind !== 'immediate') throw new Error('The synthetic target-version proposal was not saved.');
    const draft = await proposals.findRequest(OWNER_ID, runningTurn.id, 'acceptance-revalidation-race-proposal');
    if (!draft) throw new Error('The synthetic target-version proposal was not persisted.');
    await conversations.completeTurnWithAssistant({
      ownerId: OWNER_ID, conversationId: conversation.id, turnId: runningTurn.id,
      content: 'Saved the synthetic proposal.', status: 'completed'
    });

    let releaseValidation!: () => void;
    let signalValidationReached!: () => void;
    const validationPromise = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const validationReached = new Promise<void>((resolve) => { signalValidationReached = resolve; });
    targetRevalidationBarrier = {
      taskId, claimed: false, promise: validationPromise, reached: validationReached,
      signalReached: signalValidationReached, release: releaseValidation
    };
    const delayedAcceptance = proposalUseCases.accept({
      ownerId: OWNER_ID, conversationId: conversation.id, proposalId: draft.id, expectedRevision: draft.revision
    });
    await targetRevalidationBarrier.reached;
    let winningAcceptance: Awaited<ReturnType<HomeChangeProposalUseCases['accept']>>;
    try {
      winningAcceptance = await proposalUseCases.accept({
        ownerId: OWNER_ID, conversationId: conversation.id, proposalId: draft.id, expectedRevision: draft.revision
      });
    } finally {
      targetRevalidationBarrier.release();
      targetRevalidationBarrier = null;
    }
    const delayedReplay = await delayedAcceptance;

    expect(winningAcceptance).toMatchObject({ replayed: false, proposal: { state: 'completed', acceptedRevision: draft.revision } });
    expect(delayedReplay).toMatchObject({
      replayed: true, proposal: {
        id: draft.id, state: 'completed', acceptedRevision: draft.revision,
        acceptanceId: winningAcceptance.proposal.acceptanceId
      }, execution: { state: 'completed' }
    });
    const updateReceipts: readonly { id: string; target_id: string }[] = await dataSource.query(
      'SELECT "id", "target_id" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "turn_id" = $2 AND "action_kind" = $3',
      [OWNER_ID, runningTurn.id, 'task.update']
    );
    expect(updateReceipts).toHaveLength(1);
    expect(updateReceipts[0]?.target_id).toBe(taskId);
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
