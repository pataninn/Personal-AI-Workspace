/** Base type for Home conversation errors that map to a stable API response. */
export class HomeConversationDomainError extends Error {
  public constructor(message: string, public readonly code: string, public readonly statusCode: number) {
    super(message);
    this.name = 'HomeConversationDomainError';
  }
}

/** Raised when a Home history lookup does not match the supplied owner. */
export class HomeConversationNotFoundError extends HomeConversationDomainError {
  public constructor() {
    super('The Home conversation was not found.', 'HOME_CONVERSATION_NOT_FOUND', 404);
    this.name = 'HomeConversationNotFoundError';
  }
}

/** Raised when a turn lookup does not match the supplied owner and conversation. */
export class HomeTurnNotFoundError extends HomeConversationDomainError {
  public constructor() {
    super('The Home turn was not found.', 'HOME_TURN_NOT_FOUND', 404);
    this.name = 'HomeTurnNotFoundError';
  }
}

/** Raised when a turn status update would skip or reverse its lifecycle. */
export class HomeTurnTransitionInvalidError extends HomeConversationDomainError {
  public constructor(from: string, to: string) {
    super(`The Home turn cannot transition from ${from} to ${to}.`, 'HOME_TURN_TRANSITION_INVALID', 409);
    this.name = 'HomeTurnTransitionInvalidError';
  }
}

/** Raised when a request key is reused with a different canonical request. */
export class HomeRequestKeyReusedError extends HomeConversationDomainError {
  public constructor(operation: 'conversation' | 'turn' | 'message') {
    super(`The Home ${operation} request key was already used with different input.`, 'HOME_REQUEST_KEY_REUSED', 409);
    this.name = 'HomeRequestKeyReusedError';
  }
}

/** Raised when stored scope fields do not match the Home conversation scope. */
export class HomeConversationScopeInvalidError extends HomeConversationDomainError {
  public constructor() {
    super('The stored Home conversation scope is invalid.', 'HOME_CONVERSATION_SCOPE_INVALID', 500);
    this.name = 'HomeConversationScopeInvalidError';
  }
}

/** Raised when a Home conversation list cursor cannot be decoded. */
export class HomeConversationCursorInvalidError extends HomeConversationDomainError {
  public constructor() {
    super('The Home conversation cursor is invalid.', 'VALIDATION_ERROR', 400);
    this.name = 'HomeConversationCursorInvalidError';
  }
}

/** Raised when a durable event cursor is negative or outside the database integer range. */
export class HomeEventCursorInvalidError extends HomeConversationDomainError {
  public constructor() {
    super('The Home event cursor is invalid.', 'VALIDATION_ERROR', 400);
    this.name = 'HomeEventCursorInvalidError';
  }
}

/** Raised when a persisted or requested turn cannot be cancelled in its current state. */
export class HomeTurnNotCancellableError extends HomeConversationDomainError {
  public constructor() {
    super('The Home turn is not cancellable in its current state.', 'HOME_TURN_NOT_CANCELLABLE', 409);
    this.name = 'HomeTurnNotCancellableError';
  }
}

/** Raised when an assistant action is attached to a turn that is no longer running. */
export class HomeTurnNotActiveError extends HomeConversationDomainError {
  public constructor() {
    super('The Home turn is no longer active.', 'HOME_TURN_NOT_ACTIVE', 409);
    this.name = 'HomeTurnNotActiveError';
  }
}

/** Raised when a consent decision is expired, consumed, or conflicts with the saved decision. */
export class HomeConsentDecisionStaleError extends HomeConversationDomainError {
  public constructor() {
    super('The Home consent decision is stale or conflicts with the saved decision.', 'HOME_CONSENT_DECISION_STALE', 409);
    this.name = 'HomeConsentDecisionStaleError';
  }
}

/** Raised when the persistence layer returns an event shape outside the API allowlist. */
export class HomeConversationEventInvalidError extends HomeConversationDomainError {
  public constructor() {
    super('The Home event record is invalid.', 'HOME_EVENT_INVALID', 500);
    this.name = 'HomeConversationEventInvalidError';
  }
}

/** Raised when a Home API command fails domain-level bounds or idempotency-key rules. */
export class HomeConversationInputInvalidError extends HomeConversationDomainError {
  public constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'HomeConversationInputInvalidError';
  }
}

/** Raised when a redacted Home transcript cannot fit the provider prompt ceiling. */
export class HomePlanningContextTooLargeError extends HomeConversationInputInvalidError {
  public constructor() {
    super('The redacted conversation context exceeds the provider request limit.');
    this.name = 'HomePlanningContextTooLargeError';
  }
}

/** Raised when rollback would remove persisted Home conversation data. */
export class HomeConversationRollbackBlockedError extends Error {
  public constructor() {
    super('Cannot revert Home conversation persistence while Home history rows exist.');
    this.name = 'HomeConversationRollbackBlockedError';
  }
}

/** Raised when rollback would discard event history or a status introduced by the event API. */
export class HomeConversationEventRollbackBlockedError extends Error {
  public constructor() {
    super('Cannot revert Home event persistence while events or new turn states exist.');
    this.name = 'HomeConversationEventRollbackBlockedError';
  }
}

/** Raised when rollback would discard persisted consent decisions or disclosure history. */
export class HomeConsentRollbackBlockedError extends Error {
  public constructor() {
    super('Cannot revert Home consent persistence while disclosure history exists.');
    this.name = 'HomeConsentRollbackBlockedError';
  }
}
