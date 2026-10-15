import type {
  ActionLedgerExecutionInput,
  ActionLedgerMutationResult,
  ActionLedgerRecord,
  PersistedActionLedgerRecord
} from '@/modules/action-ledger/domain/action-ledger-types';
import { ActionLedgerOperationKeyReusedError } from '@/modules/action-ledger/domain/action-ledger-errors';
import type { IActionLedgerRepository } from '@/modules/action-ledger/repositories/action-ledger-repository';
import type { GlobalTaskQueryItem } from '@/modules/tasks/domain/global-task-query';
import type { ProjectTask } from '@/modules/tasks/domain/project-task';
import type { IGlobalTaskQueryRepository } from '@/modules/tasks/repositories/global-task-query-repository';
import type {
  AppliedTaskMutation,
  ArchiveTaskMutationInput,
  CreateTaskMutationInput,
  ITaskMutationParticipant,
  MoveTaskMutationInput,
  UpdateTaskMutationInput
} from '@/modules/tasks/repositories/task-mutation-participant';
import { TaskMutationUseCases } from '@/modules/tasks/use-cases/task-mutation-use-cases';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-16T08:00:00.000Z');

function makeTask(projectId: string | null, version = 1, changes: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: TASK,
    projectId,
    title: 'Review the plan',
    details: 'Keep the date clear',
    status: 'todo',
    importance: 'medium',
    deadline: '2026-10-21',
    subtasks: [],
    position: 0,
    version,
    source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
    ...changes
  };
}

function item(task: ProjectTask): GlobalTaskQueryItem {
  return {
    task,
    collection: task.projectId ? 'workspace' : 'inbox',
    workspace: task.projectId ? { id: task.projectId, name: 'Planning', status: 'active' } : null
  };
}

class FakeLedger implements IActionLedgerRepository<string> {
  public readonly calls: ActionLedgerExecutionInput[] = [];
  private readonly rows = new Map<string, PersistedActionLedgerRecord>();

  public async executeAtomically(input: ActionLedgerExecutionInput, mutate: (transaction: string) => Promise<ActionLedgerMutationResult>): Promise<PersistedActionLedgerRecord> {
    this.calls.push(input);
    const identity = `${input.ownerId}:${input.operationKey}`;
    const prior = this.rows.get(identity);
    if (prior) {
      if (prior.record.requestFingerprint !== input.requestFingerprint) throw new ActionLedgerOperationKeyReusedError();
      return { ...prior, replayed: true };
    }
    const result = await mutate('tx');
    const record: ActionLedgerRecord = {
      ...input,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      preVersion: result.preVersion,
      postVersion: result.postVersion,
      reversibleFields: result.reversibleFields,
      outcome: result.outcome,
      undoStatus: result.undoStatus,
      undoActionId: null,
      createdAt: NOW.toISOString()
    };
    const persisted = { record, replayed: false };
    this.rows.set(identity, persisted);
    return persisted;
  }

  public async findForOwner(): Promise<ActionLedgerRecord | null> {
    return null;
  }
}

class FakeParticipant implements ITaskMutationParticipant<string> {
  public readonly createInTransaction = jest.fn(async (_transaction: string, input: CreateTaskMutationInput): Promise<AppliedTaskMutation> => {
    this.currentTask = makeTask(input.projectId, 1, {
      id: input.taskId,
      title: input.title,
      details: input.details,
      importance: input.importance,
      deadline: input.deadline,
      subtasks: input.subtasks,
      status: input.subtasks.length > 0 && input.subtasks.every((subtask) => subtask.completed) ? 'done' : 'todo'
    });
    return {
      preVersion: null,
      postVersion: 1,
      reversibleFields: {},
      outcome: { targetId: input.taskId, targetVersion: 1, destinationOrderVersion: 2 },
      undoStatus: 'available',
      task: this.currentTask
    };
  });
  public readonly updateInTransaction = jest.fn(async (_transaction: string, input: UpdateTaskMutationInput): Promise<AppliedTaskMutation> => {
    const before = this.currentTask ?? makeTask(null);
    const task = makeTask(before.projectId, before.version + 1, {
      ...before,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.details === undefined ? {} : { details: input.details }),
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
      ...(input.status === undefined ? {} : { status: input.status })
    });
    this.currentTask = task;
    return {
      preVersion: before.version,
      postVersion: task.version,
      reversibleFields: {},
      outcome: { targetId: task.id, targetVersion: task.version, sourceOrderVersion: 3 },
      undoStatus: 'not_reversible',
      task
    };
  });
  public readonly moveInTransaction = jest.fn(async (_transaction: string, input: MoveTaskMutationInput): Promise<AppliedTaskMutation> => this.mutationFor(input.taskId, input.destinationProjectId, input.expectedVersion + 1));
  public readonly archiveInTransaction = jest.fn(async (_transaction: string, input: ArchiveTaskMutationInput): Promise<AppliedTaskMutation> => this.mutationFor(input.taskId, null, input.expectedVersion + 1));
  public currentTask: ProjectTask | null = null;

  private mutationFor(taskId: string, projectId: string | null, version: number): AppliedTaskMutation {
    const task = makeTask(projectId, version, { id: taskId });
    this.currentTask = task;
    return {
      preVersion: version - 1,
      postVersion: version,
      reversibleFields: {},
      outcome: { targetId: taskId, targetVersion: version },
      undoStatus: 'available',
      task
    };
  }
}

function fixture() {
  const ledger = new FakeLedger();
  const participant = new FakeParticipant();
  const taskQuery: IGlobalTaskQueryRepository = {
    listGlobalTasks: jest.fn(),
    getGlobalTask: jest.fn(async ({ taskId }: { readonly taskId: string }) => participant.currentTask?.id === taskId ? item(participant.currentTask) : null)
  } as unknown as IGlobalTaskQueryRepository;
  return { useCases: new TaskMutationUseCases(ledger, participant, taskQuery), ledger, participant, taskQuery };
}

describe('TaskMutationUseCases', () => {
  it('uses normalized, server-computed identity and replays create before invoking the participant again', async () => {
    const { useCases, ledger, participant } = fixture();

    const first = await useCases.create({
      ownerId: OWNER,
      operationKey: 'capture-once',
      title: '  Review the plan  ',
      deadline: '2024-02-29',
      subtasks: [{ title: 'Check dates' }]
    });
    const replay = await useCases.create({
      ownerId: OWNER,
      operationKey: 'capture-once',
      title: 'Review the plan',
      deadline: '2024-02-29',
      subtasks: [{ title: 'Check dates' }]
    });

    expect(first.item.task.title).toBe('Review the plan');
    expect(first.item.task.deadline).toBe('2024-02-29');
    expect(replay.item.task.id).toBe(first.item.task.id);
    expect(replay.replayed).toBe(true);
    expect(participant.createInTransaction).toHaveBeenCalledTimes(1);
    expect(ledger.calls[0]).toMatchObject({ ownerId: OWNER, actorKind: 'manual', turnId: null, expectedVersion: null, actionKind: 'task.create' });
  });

  it('rejects a key reused with a different normalized request before the participant runs again', async () => {
    const { useCases, participant } = fixture();
    await useCases.create({ ownerId: OWNER, operationKey: 'capture-once', title: 'First task' });

    await expect(useCases.create({ ownerId: OWNER, operationKey: 'capture-once', title: 'Another task' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
    expect(participant.createInTransaction).toHaveBeenCalledTimes(1);
  });

  it('preserves explicit null clearing and normalizes exact calendar-date values for patches', async () => {
    const { useCases, participant } = fixture();
    participant.currentTask = makeTask(null);

    await useCases.update({ ownerId: OWNER, taskId: TASK, expectedVersion: 1, operationKey: 'clear-fields', details: null, deadline: null });

    expect(participant.updateInTransaction).toHaveBeenCalledWith('tx', expect.objectContaining({
      ownerId: OWNER,
      taskId: TASK,
      expectedVersion: 1,
      details: null,
      deadline: null
    }));
  });

  it('rejects mixed status and field patches and invalid dates before opening a ledger operation', async () => {
    const { useCases, ledger, participant } = fixture();

    await expect(useCases.update({ ownerId: OWNER, taskId: TASK, expectedVersion: 1, status: 'done', title: 'Edit too' }))
      .rejects.toMatchObject({ code: 'PROJECT_TASK_STATUS_CONFLICT' });
    await expect(useCases.update({ ownerId: OWNER, taskId: TASK, expectedVersion: 1, deadline: '2026-02-30' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(ledger.calls).toHaveLength(0);
    expect(participant.updateInTransaction).not.toHaveBeenCalled();
  });
});
