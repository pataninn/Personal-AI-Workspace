import { createHash } from 'node:crypto';

import type { ActionLedgerExecutionInput, ActionLedgerRecord, PersistedActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';
import {
  ActionLedgerOperationKeyReusedError,
  ActionLedgerTargetStateConflictError,
  ActionLedgerUndoNotAvailableError
} from '@/modules/action-ledger/domain/action-ledger-errors';
import type { IActionLedgerUndoRepository } from '@/modules/action-ledger/repositories/action-ledger-undo-repository';
import {
  ActionUndoConflictError,
  ActionUndoNotFoundError,
  ActionUndoOperationKeyReusedError,
  ActionUndoValidationError,
  type ActionUndoConflictReason
} from '@/modules/home-assistant/domain/action-undo-errors';
import type { ITaskUndoParticipant } from '@/modules/tasks/repositories/task-mutation-participant';
import type { IWorkspaceUndoParticipant } from '@/modules/projects/repositories/project-workspace-repository';
import type { GlobalTaskQueryItem } from '@/modules/tasks/domain/global-task-query';
import type { IGlobalTaskQueryRepository } from '@/modules/tasks/repositories/global-task-query-repository';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { Project } from '@/modules/projects/domain/project-types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPERATION_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const SUPPORTED_TASK_ACTIONS = new Set(['task.create', 'task.update', 'task.move', 'task.archive']);
const ACTION_UNDO_CONFLICT_REASONS = new Set<ActionUndoConflictReason>([
  'changed', 'not_reversible', 'already_undone', 'unsupported_action', 'target_missing',
  'archived_workspace', 'workspace_not_empty', 'folder_attached', 'missing_reversal_data'
]);

export interface UndoActionInput {
  readonly ownerId: string;
  readonly actionId: string;
  readonly operationKey: unknown;
  readonly completedTaskCreateActionIds?: readonly unknown[];
}

export interface ActionUndoCommandResult {
  readonly originalAction: ActionLedgerRecord;
  readonly undoReceipt: ActionLedgerRecord;
  readonly target: GlobalTaskQueryItem | Project | null;
  readonly replayed: boolean;
}

export interface IActionUndoUseCases {
  undo(input: UndoActionInput): Promise<ActionUndoCommandResult>;
  getReceipt(input: { readonly ownerId: string; readonly actionId: string }): Promise<ActionLedgerRecord>;
}

/** Compensates one saved action on the same transaction that commits its linked receipt. */
export class ActionUndoUseCases<TTransaction> implements IActionUndoUseCases {
  public constructor(
    private readonly ledger: IActionLedgerUndoRepository<TTransaction>,
    private readonly tasks: ITaskUndoParticipant<TTransaction> & IGlobalTaskQueryRepository,
    private readonly workspaces: IWorkspaceUndoParticipant<TTransaction> & IProjectRepository
  ) {}

  /** Returns one receipt for UI refresh without exposing reversible before/after data. */
  public async getReceipt(input: { readonly ownerId: string; readonly actionId: string }): Promise<ActionLedgerRecord> {
    if (!UUID_PATTERN.test(input.ownerId) || !UUID_PATTERN.test(input.actionId)) throw new ActionUndoNotFoundError();
    const record = await this.ledger.findActionByIdForOwner(input.ownerId, input.actionId);
    if (!record) throw new ActionUndoNotFoundError();
    return record;
  }

  public async undo(input: UndoActionInput): Promise<ActionUndoCommandResult> {
    const operationKeyInput = this.validateIdentity(input);
    const childIds = this.validateCompletedChildren(input.completedTaskCreateActionIds ?? []);
    const original = await this.ledger.findActionByIdForOwner(input.ownerId, input.actionId);
    if (!original) throw new ActionUndoNotFoundError();

    if (childIds.length > 0 && (original.targetKind !== 'workspace' || original.actionKind !== 'workspace.create')) {
      throw new ActionUndoValidationError('Child task receipts are valid only when undoing a planning workspace create.');
    }

    const operationKey = `undo:${digest([input.actionId, operationKeyInput])}`;
    const requestFingerprint = digest({
      ownerId: input.ownerId,
      actionId: original.id,
      completedTaskCreateActionIds: childIds
    });
    const execution: ActionLedgerExecutionInput = {
      ownerId: input.ownerId,
      operationKey,
      requestFingerprint,
      actorKind: 'manual',
      turnId: null,
      targetKind: original.targetKind,
      targetId: original.targetId,
      actionKind: 'undo',
      expectedVersion: original.postVersion,
      undoOfActionId: original.id
    };

    let persisted: PersistedActionLedgerRecord;
    try {
      persisted = await this.ledger.executeAtomically(execution, async (transaction) => {
        if (original.targetKind === 'task') {
          if (!SUPPORTED_TASK_ACTIONS.has(original.actionKind)) throw new ActionLedgerTargetStateConflictError('unsupported_action');
          return this.tasks.undoTaskInTransaction(transaction, { ownerId: input.ownerId, original });
        }
        if (original.actionKind !== 'workspace.create' && original.actionKind !== 'workspace.update') {
          throw new ActionLedgerTargetStateConflictError('unsupported_action');
        }
        return this.workspaces.undoWorkspaceInTransaction(transaction, {
          ownerId: input.ownerId,
          original,
          completedTaskCreateActionIds: childIds
        });
      });
    } catch (error: unknown) {
      if (error instanceof ActionLedgerOperationKeyReusedError) throw new ActionUndoOperationKeyReusedError();
      if (error instanceof ActionLedgerTargetStateConflictError) {
        const reason = ACTION_UNDO_CONFLICT_REASONS.has(error.reason as ActionUndoConflictReason)
          ? error.reason as ActionUndoConflictReason
          : 'changed';
        return this.throwConflict(input.ownerId, original, reason);
      }
      if (error instanceof ActionLedgerUndoNotAvailableError) {
        const latestOriginal = await this.ledger.findActionByIdForOwner(input.ownerId, original.id);
        const reason: ActionUndoConflictReason = latestOriginal?.undoStatus === 'undone'
          ? 'already_undone'
          : latestOriginal?.undoStatus === 'not_reversible'
            ? 'not_reversible'
            : 'changed';
        return this.throwConflict(input.ownerId, latestOriginal ?? original, reason);
      }
      throw error;
    }

    const [latestOriginal, target] = await Promise.all([
      this.ledger.findActionByIdForOwner(input.ownerId, original.id),
      this.readTarget(input.ownerId, original)
    ]);
    if (!latestOriginal) throw new ActionUndoNotFoundError();
    return { originalAction: latestOriginal, undoReceipt: persisted.record, target, replayed: persisted.replayed };
  }

  private validateIdentity(input: UndoActionInput): string {
    if (!UUID_PATTERN.test(input.ownerId) || !UUID_PATTERN.test(input.actionId)) throw new ActionUndoNotFoundError();
    if (typeof input.operationKey !== 'string' || !OPERATION_KEY_PATTERN.test(input.operationKey.trim())) {
      throw new ActionUndoValidationError('A valid Idempotency-Key header is required.');
    }
    return input.operationKey.trim();
  }

  private validateCompletedChildren(values: readonly unknown[]): readonly string[] {
    if (!Array.isArray(values) || values.length > 100) throw new ActionUndoValidationError('The completed task receipt list is invalid.');
    const ids: string[] = [];
    for (const value of values) {
      if (typeof value !== 'string' || !UUID_PATTERN.test(value) || ids.includes(value)) {
        throw new ActionUndoValidationError('The completed task receipt list contains an invalid or duplicate ID.');
      }
      ids.push(value);
    }
    return ids;
  }

  private async readTarget(ownerId: string, original: ActionLedgerRecord): Promise<GlobalTaskQueryItem | Project | null> {
    if (original.targetKind === 'task') {
      return this.tasks.getGlobalTask({ ownerId, taskId: original.targetId, includeArchived: true });
    }
    return this.workspaces.findByIdForOwner(ownerId, original.targetId);
  }

  private async throwConflict(ownerId: string, original: ActionLedgerRecord, reason: ActionUndoConflictReason): Promise<never> {
    const [latestOriginal, target] = await Promise.all([
      this.ledger.findActionByIdForOwner(ownerId, original.id),
      this.readTarget(ownerId, original)
    ]);
    throw new ActionUndoConflictError(reason, latestOriginal ?? original, target);
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
