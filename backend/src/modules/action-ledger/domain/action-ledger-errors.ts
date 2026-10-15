/** Raised when an action receipt input violates the persistence contract. */
export class ActionLedgerInputInvalidError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ActionLedgerInputInvalidError';
  }
}

/** Raised when an operation key is retried with a different request fingerprint. */
export class ActionLedgerOperationKeyReusedError extends Error {
  public constructor() {
    super('The action operation key was already used with different input.');
    this.name = 'ActionLedgerOperationKeyReusedError';
  }
}

/** Raised when a compensation points to an unavailable or differently owned action. */
export class ActionLedgerUndoNotAvailableError extends Error {
  public constructor() {
    super('The action cannot be reversed because its owner-scoped undo receipt is unavailable.');
    this.name = 'ActionLedgerUndoNotAvailableError';
  }
}

/** Raised when a callback returns versions that do not satisfy its requested guard. */
export class ActionLedgerMutationResultInvalidError extends Error {
  public constructor() {
    super('The action mutation result does not match its requested version guard.');
    this.name = 'ActionLedgerMutationResultInvalidError';
  }
}

/** Raised when persisted action data cannot be mapped to the domain contract. */
export class ActionLedgerPersistenceInvariantError extends Error {
  public constructor() {
    super('The persisted action receipt does not match the action ledger contract.');
    this.name = 'ActionLedgerPersistenceInvariantError';
  }
}

/** Raised when rollback would remove persisted action history. */
export class ActionLedgerRollbackBlockedError extends Error {
  public constructor() {
    super('Cannot revert action ledger persistence while action records exist.');
    this.name = 'ActionLedgerRollbackBlockedError';
  }
}
