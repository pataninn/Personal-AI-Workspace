/** Raised when a Home history lookup does not match the supplied owner. */
export class HomeConversationNotFoundError extends Error {
  public constructor() {
    super('The Home conversation was not found.');
    this.name = 'HomeConversationNotFoundError';
  }
}

/** Raised when a turn lookup does not match the supplied owner and conversation. */
export class HomeTurnNotFoundError extends Error {
  public constructor() {
    super('The Home turn was not found.');
    this.name = 'HomeTurnNotFoundError';
  }
}

/** Raised when a turn status update would skip or reverse its lifecycle. */
export class HomeTurnTransitionInvalidError extends Error {
  public constructor(from: string, to: string) {
    super(`The Home turn cannot transition from ${from} to ${to}.`);
    this.name = 'HomeTurnTransitionInvalidError';
  }
}

/** Raised when a request key is reused with a different canonical request. */
export class HomeRequestKeyReusedError extends Error {
  public constructor(operation: 'conversation' | 'turn' | 'message') {
    super(`The Home ${operation} request key was already used with different input.`);
    this.name = 'HomeRequestKeyReusedError';
  }
}

/** Raised when stored scope fields do not match the Home conversation scope. */
export class HomeConversationScopeInvalidError extends Error {
  public constructor() {
    super('The stored Home conversation scope is invalid.');
    this.name = 'HomeConversationScopeInvalidError';
  }
}

/** Raised when a Home conversation list cursor cannot be decoded. */
export class HomeConversationCursorInvalidError extends Error {
  public constructor() {
    super('The Home conversation cursor is invalid.');
    this.name = 'HomeConversationCursorInvalidError';
  }
}

/** Raised when rollback would remove persisted Home conversation data. */
export class HomeConversationRollbackBlockedError extends Error {
  public constructor() {
    super('Cannot revert Home conversation persistence while Home history rows exist.');
    this.name = 'HomeConversationRollbackBlockedError';
  }
}
