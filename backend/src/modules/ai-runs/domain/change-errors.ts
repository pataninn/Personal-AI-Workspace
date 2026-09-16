import type { ErrorDetail } from '@/shared/errors/app-error';

export class ChangeSetDomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: readonly ErrorDetail[];

  public constructor(code: string, statusCode: number, message: string, details: readonly ErrorDetail[] = []) {
    super(message);
    this.name = 'ChangeSetDomainError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ChangeSetNotFoundError extends ChangeSetDomainError {
  public constructor() {
    super('CHANGE_SET_NOT_FOUND', 404, 'The proposed change set was not found.');
  }
}

export class ChangeSetValidationError extends ChangeSetDomainError {
  public constructor(details: readonly ErrorDetail[], message = 'The proposed change set is invalid.') {
    super('CHANGE_SET_INVALID', 400, message, details);
  }
}

export class ChangeSetBlockedError extends ChangeSetDomainError {
  public constructor(message = 'This proposed change set cannot be applied safely.') {
    super('CHANGE_SET_BLOCKED', 422, message);
  }
}

export class ChangeSetConflictError extends ChangeSetDomainError {
  public constructor(message = 'The proposed change set is no longer current.') {
    super('CHANGE_SET_CONFLICT', 409, message);
  }
}

export class ChangeSetAlreadyDecidedError extends ChangeSetDomainError {
  public constructor() {
    super('CHANGE_SET_ALREADY_DECIDED', 409, 'This proposed change set already has a decision.');
  }
}

export class ChangeSetIdempotencyReusedError extends ChangeSetDomainError {
  public constructor() {
    super('CHANGE_SET_IDEMPOTENCY_REUSED', 409, 'This retry key was already used for different change-set content.');
  }
}

export class ChangeSetReviewRequiredError extends ChangeSetDomainError {
  public constructor() {
    super('CHANGE_SET_REVIEW_REQUIRED', 503, 'The apply outcome could not be confirmed. Refresh apply status and inspect the project.');
  }
}

