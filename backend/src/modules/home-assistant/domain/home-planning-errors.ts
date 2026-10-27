import { HomeConversationDomainError } from '@/modules/home-assistant/domain/home-conversation-errors';

export class HomePlanningScopeConflictError extends HomeConversationDomainError {
  public constructor() {
    super('The requested Home planning target is outside this conversation scope.', 'HOME_SCOPE_CONFLICT', 409);
    this.name = 'HomePlanningScopeConflictError';
  }
}

export class HomeProposalNotFoundError extends HomeConversationDomainError {
  public constructor() {
    super('The Home proposal was not found.', 'HOME_PROPOSAL_NOT_FOUND', 404);
    this.name = 'HomeProposalNotFoundError';
  }
}

export class HomeProposalRevisionConflictError extends HomeConversationDomainError {
  public constructor() {
    super('The Home proposal changed. Reload it before continuing.', 'HOME_PROPOSAL_REVISION_CONFLICT', 409);
    this.name = 'HomeProposalRevisionConflictError';
  }
}

export class HomeProposalRequestKeyReusedError extends HomeConversationDomainError {
  public constructor() {
    super('The Home proposal request ID was reused with different input.', 'HOME_PROPOSAL_REQUEST_REUSED', 409);
    this.name = 'HomeProposalRequestKeyReusedError';
  }
}

export class HomeProposalNotEditableError extends HomeConversationDomainError {
  public constructor() {
    super('The Home proposal can no longer be edited.', 'HOME_PROPOSAL_NOT_EDITABLE', 409);
    this.name = 'HomeProposalNotEditableError';
  }
}

export class HomeProposalDependencyConflictError extends HomeConversationDomainError {
  public constructor() {
    super('Remove or retarget items that depend on this workspace before deleting it.', 'HOME_PROPOSAL_DEPENDENCY_CONFLICT', 409);
    this.name = 'HomeProposalDependencyConflictError';
  }
}

export class HomeProposalNotAcceptableError extends HomeConversationDomainError {
  public constructor() {
    super('The Home proposal cannot be accepted in its current state.', 'HOME_PROPOSAL_NOT_ACCEPTABLE', 409);
    this.name = 'HomeProposalNotAcceptableError';
  }
}

export class HomeProposalCancelledError extends HomeConversationDomainError {
  public constructor() {
    super('The Home proposal was cancelled before this action could be saved.', 'HOME_PROPOSAL_ALREADY_CANCELLED', 409);
    this.name = 'HomeProposalCancelledError';
  }
}

export class HomeProposalInputInvalidError extends HomeConversationDomainError {
  public constructor(message = 'The Home proposal request is invalid.') {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'HomeProposalInputInvalidError';
  }
}

export class HomeProposalRollbackBlockedError extends Error {
  public constructor() {
    super('Cannot revert Home proposal persistence while proposal history exists.');
    this.name = 'HomeProposalRollbackBlockedError';
  }
}
