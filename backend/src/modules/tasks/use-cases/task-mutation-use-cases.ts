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
  /** Trusted stable target ID for a sealed Home proposal item. */
  readonly taskId?: string;
  readonly operationKey: string;
  readonly actorKind?: ActionLedgerActorKind;
  readonly turnId?: string | null;
  readonly eventContext?: unknown;
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
  readonly eventContext?: unknown;
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
  readonly eventContext?: unknown;
}

export interface TaskMutationDeleteInput {
  readonly ownerId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly expectedProjectId?: string | null;
  readonly operationKey?: string;
  readonly actorKind?: ActionLedgerActorKind;
  readonly turnId?: string | null;
  readonly eventContext?: unknown;
}

export interface TaskMutationCommandResult {
  readonly item: NonNullable<Awaited<ReturnType<IGlobalTaskQueryRepository['getGlobalTask']>>>;
  readonly receipt: ActionLedgerRecord;
  readonly replayed: boolean;
}

export interface TaskMutationDeleteCommandResult {
  readonly taskId: string;
  readonly orderVersion: number;
  readonly receipt: ActionLedgerRecord;
  readonly replayed: boolean;
}

export interface ITaskMutationCommands {
  create(input: TaskMutationCreateInput): Promise<TaskMutationCommandResult>;
  update(input: TaskMutationUpdateInput): Promise<TaskMutationCommandResult>;
  move(input: TaskMutationMoveInput): Promise<TaskMutationCommandResult>;
  findDeleteReplay(input: TaskMutationDeleteInput): Promise<TaskMutationDeleteCommandResult | null>;
  delete(input: TaskMutationDeleteInput): Promise<TaskMutationDeleteCommandResult>;
}

interface NormalizedPatch {
  readonly status?: ProjectTaskStatus;
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
export function projectTaskOperationKey(action: 'create' | 'update' | 'delete', projectId: string, requestIdentity: string): string {
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
    if (!isProjectTaskStatus(input.status)) {
      throw new ProjectTaskStatusConflictError();
    }
    return { patch: { status: input.status }, request: { status: input.status } };
  }

  const patch: {
    status?: ProjectTaskStatus;
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

/** Canonical assistant-action fingerprint shared with Home's sealed proposal recorder. */
export function taskMutationFingerprint(
  action: 'task.create' | 'task.update' | 'task.move' | 'task.delete',
  input: TaskMutationCreateInput | TaskMutationUpdateInput | TaskMutationMoveInput | TaskMutationDeleteInput
): string {
  const actorKind = input.actorKind ?? 'manual';
  if (action === 'task.create') {
    const create = input as TaskMutationCreateInput;
    const normalized = normalizeCreate(create);
    return commandFingerprint({
      ownerId: create.ownerId, actionKind: action, actorKind, expectedVersion: null,
      request: { projectId: create.projectId ?? null, expectedOrderVersion: create.expectedOrderVersion ?? null, ...normalized.request }
    });
  }
  if (action === 'task.update') {
    const update = input as TaskMutationUpdateInput;
    const normalized = normalizePatch(update);
    return commandFingerprint({
      ownerId: update.ownerId, actionKind: action, actorKind, targetId: update.taskId, expectedVersion: update.expectedVersion,
      request: { expectedProjectId: update.expectedProjectId ?? null, ...normalized.request }
    });
  }
  if (action === 'task.move') {
    const move = input as TaskMutationMoveInput;
    return commandFingerprint({
      ownerId: move.ownerId, actionKind: action, actorKind, targetId: move.taskId, expectedVersion: move.expectedVersion,
      request: {
        workspaceId: move.workspaceId,
        expectedSourceOrderVersion: move.expectedSourceOrderVersion ?? null,
        expectedDestinationOrderVersion: move.expectedDestinationOrderVersion ?? null
      }
    });
  }
  const deletion = input as TaskMutationDeleteInput;
  return commandFingerprint({
    ownerId: deletion.ownerId, actionKind: action, actorKind, targetId: deletion.taskId, expectedVersion: deletion.expectedVersion,
    request: {}
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
    const requestFingerprint = taskMutationFingerprint('task.create', input);
    const taskId = input.taskId ?? randomUUID();
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
      })), input.eventContext);
    } catch (error: unknown) {
      ledgerError(error);
    }
    return this.result(input.ownerId, persisted);
  }

  public async update(input: TaskMutationUpdateInput): Promise<TaskMutationCommandResult> {
    const { patch } = normalizePatch(input);
    const actorKind = input.actorKind ?? 'manual';
    const requestFingerprint = taskMutationFingerprint('task.update', input);
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
      })), input.eventContext);
    } catch (error: unknown) {
      ledgerError(error);
    }
    return this.result(input.ownerId, persisted);
  }

  public async move(input: TaskMutationMoveInput): Promise<TaskMutationCommandResult> {
    const actorKind = input.actorKind ?? 'manual';
    const requestFingerprint = taskMutationFingerprint('task.move', input);
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
      })), input.eventContext);
    } catch (error: unknown) {
      ledgerError(error);
    }
    return this.result(input.ownerId, persisted);
  }

  public async delete(input: TaskMutationDeleteInput): Promise<TaskMutationDeleteCommandResult> {
    const actorKind = input.actorKind ?? 'manual';
    const requestFingerprint = taskMutationFingerprint('task.delete', input);
    const command = executionInput({
      ownerId: input.ownerId,
      operationKey: operationKey(input.operationKey, requestFingerprint),
      requestFingerprint,
      actorKind,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      targetId: input.taskId,
      actionKind: 'task.delete',
      expectedVersion: input.expectedVersion
    });
    let persisted: PersistedActionLedgerRecord;
    try {
      persisted = await this.ledger.executeAtomically(command, async (transaction) => this.participant.deleteInTransaction(transaction, {
        ownerId: input.ownerId,
        taskId: input.taskId,
        expectedVersion: input.expectedVersion,
        ...(input.expectedProjectId === undefined ? {} : { expectedProjectId: input.expectedProjectId }),
        actorKind
      }), input.eventContext);
    } catch (error: unknown) {
      ledgerError(error);
    }
    const orderVersion = persisted.record.outcome.sourceOrderVersion;
    if (orderVersion === undefined || orderVersion === null) {
      throw new Error('The deleted task receipt is missing its collection order version.');
    }
    return { taskId: input.taskId, orderVersion, receipt: persisted.record, replayed: persisted.replayed };
  }

  /** Returns an exact prior delete receipt before callers need to read a now-removed task. */
  public async findDeleteReplay(input: TaskMutationDeleteInput): Promise<TaskMutationDeleteCommandResult | null> {
    const actorKind = input.actorKind ?? 'manual';
    const requestFingerprint = taskMutationFingerprint('task.delete', input);
    const operationKeyValue = operationKey(input.operationKey, requestFingerprint);
    const record = await this.ledger.findForOwner(input.ownerId, operationKeyValue);
    if (!record || record.ownerId !== input.ownerId || record.operationKey !== operationKeyValue
      || record.requestFingerprint !== requestFingerprint || record.actorKind !== actorKind
      || record.turnId !== (actorKind === 'manual' ? null : input.turnId ?? null)
      || record.targetKind !== 'task' || record.targetId !== input.taskId || record.actionKind !== 'task.delete'
      || record.expectedVersion !== input.expectedVersion || record.undoOfActionId !== null
      || record.outcome.targetId !== input.taskId) return null;
    const orderVersion = record.outcome.sourceOrderVersion;
    if (typeof orderVersion !== 'number' || !Number.isSafeInteger(orderVersion) || orderVersion <= 0) {
      throw new Error('The deleted task receipt is missing its collection order version.');
    }
    return { taskId: input.taskId, orderVersion, receipt: record, replayed: true };
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
