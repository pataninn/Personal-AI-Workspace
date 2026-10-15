import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';

export type ActionUndoConflictReason =
  | 'changed'
  | 'not_reversible'
  | 'already_undone'
  | 'unsupported_action'
  | 'target_missing'
  | 'archived_workspace'
  | 'workspace_not_empty'
  | 'folder_attached'
  | 'missing_reversal_data';

/** Domain validation and conflict raised while applying a saved action receipt. */
export class ActionUndoDomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  public constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = 'ActionUndoDomainError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ActionUndoValidationError extends ActionUndoDomainError {
  public constructor(message = 'The undo request is invalid.') {
    super('VALIDATION_ERROR', 400, message);
  }
}

export class ActionUndoNotFoundError extends ActionUndoDomainError {
  public constructor() {
    super('ACTION_NOT_FOUND', 404, 'The action receipt was not found.');
  }
}

export class ActionUndoOperationKeyReusedError extends ActionUndoDomainError {
  public constructor() {
    super('IDEMPOTENCY_KEY_REUSED', 409, 'The Idempotency-Key was already used for a different undo request.');
  }
}

/** Owner-safe 409 response data, populated only after current state is reloaded. */
export class ActionUndoConflictError extends ActionUndoDomainError {
  public constructor(
    public readonly reason: ActionUndoConflictReason,
    public readonly originalAction: ActionLedgerRecord,
    public readonly target: unknown
  ) {
    super('ACTION_UNDO_CONFLICT', 409, 'The saved action cannot be undone because the target has changed.');
    this.name = 'ActionUndoConflictError';
  }
}
