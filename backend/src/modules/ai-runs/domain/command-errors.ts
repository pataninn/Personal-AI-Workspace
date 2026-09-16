import type { ErrorDetail } from '@/shared/errors/app-error';

export class SandboxCommandDomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: readonly ErrorDetail[];

  public constructor(code: string, statusCode: number, message: string, details: readonly ErrorDetail[] = []) {
    super(message);
    this.name = 'SandboxCommandDomainError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class SandboxCommandValidationError extends SandboxCommandDomainError {
  public constructor(details: readonly ErrorDetail[]) {
    super('VALIDATION_ERROR', 400, details.length > 0 ? `The sandbox command proposal is invalid: ${details[0]?.message ?? 'invalid input'}` : 'The sandbox command proposal is invalid.', details);
  }
}

export class SandboxCommandNotFoundError extends SandboxCommandDomainError {
  public constructor() {
    super('COMMAND_NOT_FOUND', 404, 'The sandbox command was not found.');
  }
}

export class SandboxCommandRunNotReadyError extends SandboxCommandDomainError {
  public constructor() {
    super('COMMAND_RUN_NOT_READY', 409, 'The private run is not ready to execute a sandbox command.');
  }
}

export class SandboxCommandProjectArchivedError extends SandboxCommandDomainError {
  public constructor() {
    super('PROJECT_ARCHIVED', 409, 'This project is archived. Sandbox commands are read-only.');
  }
}

export class SandboxCommandProposalConflictError extends SandboxCommandDomainError {
  public constructor() {
    super('COMMAND_PROPOSAL_CONFLICT', 409, 'The command proposal is no longer current.');
  }
}

export class SandboxCommandDecisionConflictError extends SandboxCommandDomainError {
  public constructor() {
    super('COMMAND_DECISION_CONFLICT', 409, 'This command already has a different decision.');
  }
}

export class SandboxCommandBlockedError extends SandboxCommandDomainError {
  public constructor() {
    super('COMMAND_BLOCKED', 409, 'The sandbox policy blocked this command.');
  }
}

export class SandboxCommandReviewRequiredError extends SandboxCommandDomainError {
  public constructor() {
    super('COMMAND_REVIEW_REQUIRED', 503, 'The command stopped, but cleanup could not be confirmed. Refresh before retrying.');
  }
}
