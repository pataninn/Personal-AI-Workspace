import type { ErrorDetail } from '@/shared/errors/app-error';

export class AiRunDomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: readonly ErrorDetail[];

  public constructor(code: string, statusCode: number, message: string, details: readonly ErrorDetail[] = []) {
    super(message);
    this.name = 'AiRunDomainError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class AiRunNotFoundError extends AiRunDomainError {
  public constructor() {
    super('AI_RUN_NOT_FOUND', 404, 'The AI run was not found.');
  }
}

export class AiRunValidationError extends AiRunDomainError {
  public constructor(details: readonly ErrorDetail[]) {
    super('VALIDATION_ERROR', 400, 'The AI run request is invalid.', details);
  }
}

export class AiRunIdempotencyRequiredError extends AiRunDomainError {
  public constructor() {
    super('IDEMPOTENCY_KEY_REQUIRED', 400, 'A valid Idempotency-Key header is required.');
  }
}

export class AiRunIdempotencyReusedError extends AiRunDomainError {
  public constructor() {
    super('IDEMPOTENCY_KEY_REUSED', 409, 'The Idempotency-Key was already used for a different request.');
  }
}

export class AiRunManifestConflictError extends AiRunDomainError {
  public constructor() {
    super('EGRESS_MANIFEST_CONFLICT', 409, 'This disclosure is no longer current. Review the updated scope before approving.');
  }
}

export class AiRunSourceChangedError extends AiRunDomainError {
  public constructor() {
    super('EGRESS_SOURCE_CHANGED', 409, 'The approved project context changed. Review the updated disclosure before approving.');
  }
}

export class AiRunAlreadyDecidedError extends AiRunDomainError {
  public constructor() {
    super('EGRESS_DECISION_CONFLICT', 409, 'This run already has a different egress decision.');
  }
}

export class AiRunRuntimeUnavailableError extends AiRunDomainError {
  public constructor() {
    super('RUNTIME_UNAVAILABLE', 503, 'The local sandbox gateway is unavailable. Nothing was staged or sent to NVIDIA. Check the local app services, then try again.');
  }
}

export class AiRunStagingFailedError extends AiRunDomainError {
  public readonly cleanup: 'complete' | 'unknown';

  public constructor(cleanup: 'complete' | 'unknown' = 'complete') {
    super('STAGING_FAILED', 503, 'We could not prepare the private run environment. No provider call was started.');
    this.cleanup = cleanup;
  }
}

export class AiRunReviewRequiredError extends AiRunDomainError {
  public constructor() {
    super('RUN_REVIEW_REQUIRED', 503, 'The run stopped, but the app could not confirm whether cleanup or provider transmission finished. Do not retry automatically; refresh the run status before trying again.');
  }
}
