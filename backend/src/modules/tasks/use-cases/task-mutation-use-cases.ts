import { createHash, randomUUID } from 'node:crypto';

import { ActionLedgerOperationKeyReusedError } from '@/modules/action-ledger/domain/action-ledger-errors';
import type {
  ActionLedgerActionKind,
  ActionLedgerActorKind,
  ActionLedgerExecutionInput,
  ActionLedgerRecord,
  PersistedActionLedgerRecord
} from '@/modules/action-ledger/domain/action-ledger-types';
import type { IActionLedgerRepository } from '@/modules/action-ledger/repositories/action-ledger-repository';
import { ProjectTaskIdempotencyKeyError, ProjectTaskIdempotencyReusedError, ProjectTaskNotFoundError, ProjectTaskStatusConflictError, ProjectTaskValidationError } from '@/modules/tasks/domain/project-task-errors';
import type { ProjectTaskImportance, ProjectTaskSubtask, ProjectTaskStatus } from '@/modules/tasks/domain/project-task';
import { canTransitionProjectTask, isProjectTaskStatus, normalizeTaskDetails, normalizeTaskTitle } from '@/modules/tasks/domain/project-task-validation';
import { normalizeTaskDeadline, normalizeTaskImportance, normalizeTaskSubtasks } from '@/modules/tasks/domain/task-planning-validation';
import type { IGlobalTaskQueryRepository } from '@/modules/tasks/repositories/global-task-query-repository';
import type {
  AppliedTaskMutation,
  ITaskMutationParticipant
} from '@/modules/tasks/repositories/task-mutation-participant';

export interface TaskMutationCreateInput {
  readonly ownerId: string;
  readonly projectId?: string | null;
  readonly operationKey: string;
  readonly actorKind?: ActionLedgerActorKind;
  readonly turnId?: string | null;
  readonly expectedOrderVersion?: number;
  readonly title: unknown;
  readonly details?: unknown;
  readonly importance?: unknown;
  readonly deadline?: unknown;
  readonly subtasks?: unknown;
}

export interface TaskPatchInput {
  readonly title?: unknown;
  readonly details?: unknown;
  readonly status?: unknown;
  readonly importance?: unknown;
  readonly deadline?: unknown;
  readonly subtasks?: unknown;
}

export interface TaskMutationUpdateInput extends TaskPatchInput {
  readonly ownerId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly expectedProjectId?: string;
  readonly operationKey?: string;
  readonly actorKind?: ActionLedgerActorKind;
  readonly turnId?: string | null;
}

export interface TaskMutationMoveInput {
  readonly ownerId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly workspaceId: string | null;
  readonly expectedSourceOrderVersion?: number;
  readonly expectedDestinationOrderVersion?: number;
  readonly operationKey?: string;
  readonly actorKind?: ActionLedgerActorKind;
  readonly turnId?: string | null;
}

export interface TaskMutationArchiveInput {
  readonly ownerId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly expectedProjectId?: string;
  readonly expectedOrderVersion?: number;
  readonly operationKey?: string;
  readonly actorKind?: ActionLedgerActorKind;
  readonly turnId?: string | null;
}

export interface TaskMutationCommandResult {
  readonly item: NonNullable<Awaited<ReturnType<IGlobalTaskQueryRepository['getGlobalTask']>>>;
  readonly receipt: ActionLedgerRecord;
  readonly replayed: boolean;
}

export interface ITaskMutationCommands {
  create(input: TaskMutationCreateInput): Promise<TaskMutationCommandResult>;
  update(input: TaskMutationUpdateInput): Promise<TaskMutationCommandResult>;
  move(input: TaskMutationMoveInput): Promise<TaskMutationCommandResult>;
  archive(input: TaskMutationArchiveInput): Promise<TaskMutationCommandResult>;
}

interface NormalizedPatch {
  readonly status?: Exclude<ProjectTaskStatus, 'archived'>;
  readonly title?: string;
  readonly details?: string | null;
  readonly importance?: ProjectTaskImportance;
  readonly deadline?: string | null;
  readonly subtasks?: readonly ProjectTaskSubtask[];
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function operationKey(value: string | undefined, fingerprint: string): string {
  const key = value === undefined ? `task:${fingerprint}` : value.trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(key)) {
    throw new ProjectTaskIdempotencyKeyError();
  }
  return key;
}

/** Preserves the old project create key scope under the ledger's owner-wide key constraint. */
export function projectTaskOperationKey(action: 'create' | 'update' | 'archive', projectId: string, requestIdentity: string): string {
  const identity = requestIdentity.trim();
  if (!identity || identity.length > 200) {
    throw new ProjectTaskIdempotencyKeyError();
  }
  return `project-${action}:${hash([projectId, identity])}`;
}

function normalizedSubtaskRequest(raw: unknown, normalized: readonly ProjectTaskSubtask[]): readonly unknown[] {
  const rawItems = Array.isArray(raw) ? raw : [];
  return normalized.map((item, index) => {
    const source = rawItems[index];
    const sourceId = source && typeof source === 'object' && 'id' in source ? source.id : null;
    return { id: sourceId, title: item.title, completed: item.completed };
  });
}

function normalizePatch(input: TaskPatchInput): { readonly patch: NormalizedPatch; readonly request: Record<string, unknown> } {
  const hasStatus = input.status !== undefined;
  const hasText = input.title !== undefined || input.details !== undefined || input.importance !== undefined || input.deadline !== undefined || input.subtasks !== undefined;
  if (hasStatus && hasText) {
    throw new ProjectTaskStatusConflictError();
  }
  if (hasStatus) {
    if (!isProjectTaskStatus(input.status) || input.status === 'archived') {
      throw new ProjectTaskStatusConflictError();
    }
    return { patch: { status: input.status }, request: { status: input.status } };
  }

  const patch: {
    status?: Exclude<ProjectTaskStatus, 'archived'>;
    title?: string;
    details?: string | null;
    importance?: ProjectTaskImportance;
    deadline?: string | null;
    subtasks?: readonly ProjectTaskSubtask[];
  } = {};
  const request: Record<string, unknown> = {};
  if (input.title !== undefined) {
    patch.title = normalizeTaskTitle(input.title);
    request.title = patch.title;
  }
  if (input.details !== undefined) {
    patch.details = normalizeTaskDetails(input.details);
    request.details = patch.details;
  }
  if (input.importance !== undefined) {
    patch.importance = normalizeTaskImportance(input.importance);
    request.importance = patch.importance;
  }
  if (input.deadline !== undefined) {
    patch.deadline = normalizeTaskDeadline(input.deadline);
    request.deadline = patch.deadline;
  }
  if (input.subtasks !== undefined) {
    patch.subtasks = normalizeTaskSubtasks(input.subtasks);
    request.subtasks = normalizedSubtaskRequest(input.subtasks, patch.subtasks);
  }
  if (Object.keys(patch).length === 0) {
    throw new ProjectTaskValidationError([{ field: 'request', message: 'Provide at least one task field to update.' }]);
  }
  return { patch, request };
}

function normalizeCreate(input: TaskMutationCreateInput): {
  readonly title: string;
  readonly details: string | null;
  readonly importance: ProjectTaskImportance;
  readonly deadline: string | null;
  readonly subtasks: readonly ProjectTaskSubtask[];
  readonly request: Record<string, unknown>;
} {
  const title = normalizeTaskTitle(input.title);
  const details = normalizeTaskDetails(input.details);
  const importance = input.importance === undefined ? 'medium' : normalizeTaskImportance(input.importance);
  const deadline = input.deadline === undefined ? null : normalizeTaskDeadline(input.deadline);
  const subtasks = normalizeTaskSubtasks(input.subtasks ?? []);
  return {
    title,
    details,
    importance,
    deadline,
    subtasks,
    request: {
      title,
      details,
      importance,
      deadline,
      subtasks: normalizedSubtaskRequest(input.subtasks ?? [], subtasks)
    }
  };
}

function commandFingerprint(input: {
  readonly ownerId: string;
  readonly actionKind: ActionLedgerActionKind;
  readonly actorKind: ActionLedgerActorKind;
  readonly targetId?: string;
  readonly expectedVersion: number | null;
  readonly request: unknown;
}): string {
  return hash({
    ownerId: input.ownerId,
    actionKind: input.actionKind,
    actorKind: input.actorKind,
    ...(input.targetId ? { targetId: input.targetId } : {}),
    expectedVersion: input.expectedVersion,
    request: input.request
  });
}

function executionInput(input: {
  readonly ownerId: string;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly actorKind: ActionLedgerActorKind;
  readonly turnId?: string | null;
  readonly targetId: string;
  readonly actionKind: ActionLedgerActionKind;
  readonly expectedVersion: number | null;
}): ActionLedgerExecutionInput {
  if (input.actorKind === 'manual' && input.turnId != null) {
    throw new ProjectTaskValidationError([{ field: 'turnId', message: 'Manual task changes cannot reference an assistant turn.' }]);
  }
  return {
    ownerId: input.ownerId,
    operationKey: input.operationKey,
    requestFingerprint: input.requestFingerprint,
    actorKind: input.actorKind,
    turnId: input.actorKind === 'manual' ? null : input.turnId ?? null,
    targetKind: 'task',
    targetId: input.targetId,
    actionKind: input.actionKind,
    expectedVersion: input.expectedVersion,
    undoOfActionId: null
  };
}

function ledgerError(error: unknown): never {
  if (error instanceof ActionLedgerOperationKeyReusedError) {
    throw new ProjectTaskIdempotencyReusedError();
  }
  throw error;
}

function mutationResult(applied: AppliedTaskMutation) {
  const { task: _task, ...receipt } = applied;
  return receipt;
}

/** Executes task commands on the action ledger transaction and reloads the owner-scoped canonical item. */
export class TaskMutationUseCases<TTransaction> implements ITaskMutationCommands {
  public constructor(
    private readonly ledger: IActionLedgerRepository<TTransaction>,
    private readonly participant: ITaskMutationParticipant<TTransaction>,
    private readonly taskQuery: IGlobalTaskQueryRepository
  ) {}

  public async create(input: TaskMutationCreateInput): Promise<TaskMutationCommandResult> {
    const normalized = normalizeCreate(input);
    const projectId = input.projectId ?? null;
    const actorKind = input.actorKind ?? 'manual';
    const requestFingerprint = commandFingerprint({
      ownerId: input.ownerId,
      actionKind: 'task.create',
      actorKind,
      expectedVersion: null,
      request: { projectId, expectedOrderVersion: input.expectedOrderVersion ?? null, ...normalized.request }
    });
    const taskId = randomUUID();
    const command = executionInput({
      ownerId: input.ownerId,
      operationKey: operationKey(input.operationKey, requestFingerprint),
      requestFingerprint,
      actorKind,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      targetId: taskId,
      actionKind: 'task.create',
      expectedVersion: null
    });
    let persisted: PersistedActionLedgerRecord;
    const { request: _normalizedRequest, ...normalizedFields } = normalized;
    try {
      persisted = await this.ledger.executeAtomically(command, async (transaction) => mutationResult(await this.participant.createInTransaction(transaction, {
        ownerId: input.ownerId,
        taskId,
        projectId,
        ...normalizedFields,
        actorKind,
        ...(input.expectedOrderVersion === undefined ? {} : { expectedOrderVersion: input.expectedOrderVersion })
      })));
    } catch (error: unknown) {
      ledgerError(error);
    }
    return this.result(input.ownerId, persisted);
  }

  public async update(input: TaskMutationUpdateInput): Promise<TaskMutationCommandResult> {
    const { patch, request } = normalizePatch(input);
    const actorKind = input.actorKind ?? 'manual';
    const requestFingerprint = commandFingerprint({
      ownerId: input.ownerId,
      actionKind: 'task.update',
      actorKind,
      targetId: input.taskId,
      expectedVersion: input.expectedVersion,
      request: { expectedProjectId: input.expectedProjectId ?? null, ...request }
    });
    const command = executionInput({
      ownerId: input.ownerId,
      operationKey: operationKey(input.operationKey, requestFingerprint),
      requestFingerprint,
      actorKind,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      targetId: input.taskId,
      actionKind: 'task.update',
      expectedVersion: input.expectedVersion
    });
    let persisted: PersistedActionLedgerRecord;
    try {
      persisted = await this.ledger.executeAtomically(command, async (transaction) => mutationResult(await this.participant.updateInTransaction(transaction, {
        ownerId: input.ownerId,
        taskId: input.taskId,
        expectedVersion: input.expectedVersion,
        ...(input.expectedProjectId ? { expectedProjectId: input.expectedProjectId } : {}),
        ...patch,
        actorKind
      })));
    } catch (error: unknown) {
      ledgerError(error);
    }
    return this.result(input.ownerId, persisted);
  }

  public async move(input: TaskMutationMoveInput): Promise<TaskMutationCommandResult> {
    const actorKind = input.actorKind ?? 'manual';
    const requestFingerprint = commandFingerprint({
      ownerId: input.ownerId,
      actionKind: 'task.move',
      actorKind,
      targetId: input.taskId,
      expectedVersion: input.expectedVersion,
      request: {
        workspaceId: input.workspaceId,
        expectedSourceOrderVersion: input.expectedSourceOrderVersion ?? null,
        expectedDestinationOrderVersion: input.expectedDestinationOrderVersion ?? null
      }
    });
    const command = executionInput({
      ownerId: input.ownerId,
      operationKey: operationKey(input.operationKey, requestFingerprint),
      requestFingerprint,
      actorKind,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      targetId: input.taskId,
      actionKind: 'task.move',
      expectedVersion: input.expectedVersion
    });
    let persisted: PersistedActionLedgerRecord;
    try {
      persisted = await this.ledger.executeAtomically(command, async (transaction) => mutationResult(await this.participant.moveInTransaction(transaction, {
        ownerId: input.ownerId,
        taskId: input.taskId,
        expectedVersion: input.expectedVersion,
        destinationProjectId: input.workspaceId,
        ...(input.expectedSourceOrderVersion === undefined ? {} : { expectedSourceOrderVersion: input.expectedSourceOrderVersion }),
        ...(input.expectedDestinationOrderVersion === undefined ? {} : { expectedDestinationOrderVersion: input.expectedDestinationOrderVersion }),
        actorKind
      })));
    } catch (error: unknown) {
      ledgerError(error);
    }
    return this.result(input.ownerId, persisted);
  }

  public async archive(input: TaskMutationArchiveInput): Promise<TaskMutationCommandResult> {
    const actorKind = input.actorKind ?? 'manual';
    const requestFingerprint = commandFingerprint({
      ownerId: input.ownerId,
      actionKind: 'task.archive',
      actorKind,
      targetId: input.taskId,
      expectedVersion: input.expectedVersion,
      request: {
        expectedProjectId: input.expectedProjectId ?? null,
        expectedOrderVersion: input.expectedOrderVersion ?? null
      }
    });
    const command = executionInput({
      ownerId: input.ownerId,
      operationKey: operationKey(input.operationKey, requestFingerprint),
      requestFingerprint,
      actorKind,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      targetId: input.taskId,
      actionKind: 'task.archive',
      expectedVersion: input.expectedVersion
    });
    let persisted: PersistedActionLedgerRecord;
    try {
      persisted = await this.ledger.executeAtomically(command, async (transaction) => mutationResult(await this.participant.archiveInTransaction(transaction, {
        ownerId: input.ownerId,
        taskId: input.taskId,
        expectedVersion: input.expectedVersion,
        ...(input.expectedProjectId ? { expectedProjectId: input.expectedProjectId } : {}),
        ...(input.expectedOrderVersion === undefined ? {} : { expectedOrderVersion: input.expectedOrderVersion }),
        actorKind
      })));
    } catch (error: unknown) {
      ledgerError(error);
    }
    return this.result(input.ownerId, persisted);
  }

  private async result(ownerId: string, persisted: PersistedActionLedgerRecord): Promise<TaskMutationCommandResult> {
    const item = await this.taskQuery.getGlobalTask({ ownerId, taskId: persisted.record.outcome.targetId, includeArchived: true });
    if (!item) {
      throw new ProjectTaskNotFoundError();
    }
    return { item, receipt: persisted.record, replayed: persisted.replayed };
  }
}

/** Stable key for older project mutation callers that do not send an operation header. */
export function derivedProjectTaskOperationIdentity(input: unknown): string {
  return `legacy:${hash(input)}`;
}
