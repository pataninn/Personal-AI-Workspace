import type { ErrorDetail } from '@/shared/errors/app-error';

export class ProjectTaskDomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: readonly ErrorDetail[];

  public constructor(code: string, statusCode: number, message: string, details: readonly ErrorDetail[] = []) {
    super(message);
    this.name = 'ProjectTaskDomainError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ProjectTaskValidationError extends ProjectTaskDomainError {
  public constructor(details: readonly ErrorDetail[]) {
    super('VALIDATION_ERROR', 400, 'The project task request is invalid.', details);
  }
}

export class ProjectTaskNotFoundError extends ProjectTaskDomainError {
  public constructor() {
    super('PROJECT_TASK_NOT_FOUND', 404, 'The requested project task resource was not found.');
  }
}

export class ProjectTaskVersionRequiredError extends ProjectTaskDomainError {
  public constructor() {
    super('PRECONDITION_REQUIRED', 428, 'A valid If-Match version is required.');
  }
}

export class ProjectTaskIdempotencyKeyError extends ProjectTaskDomainError {
  public constructor() {
    super('IDEMPOTENCY_KEY_REQUIRED', 400, 'A valid Idempotency-Key header is required.');
  }
}

export class ProjectTaskIdempotencyReusedError extends ProjectTaskDomainError {
  public constructor() {
    super('IDEMPOTENCY_KEY_REUSED', 409, 'The Idempotency-Key was already used for a different request.');
  }
}

export class ProjectTaskArchivedProjectError extends ProjectTaskDomainError {
  public constructor() {
    super('PROJECT_ARCHIVED', 409, 'This project is archived. Its tasks and suggestions are read-only.');
  }
}

export class ProjectTaskVersionConflictError extends ProjectTaskDomainError {
  public constructor() {
    super('PROJECT_TASK_VERSION_CONFLICT', 409, 'This task changed before the request was applied. Reload the latest version and try again.');
  }
}

export class ProjectTaskStatusConflictError extends ProjectTaskDomainError {
  public constructor() {
    super('PROJECT_TASK_STATUS_CONFLICT', 409, 'This task cannot move to that status.');
  }
}

export class ProjectTaskArchivedError extends ProjectTaskDomainError {
  public constructor() {
    super('PROJECT_TASK_ARCHIVED', 409, 'This task is archived and cannot be changed.');
  }
}

export class ProjectTaskOrderConflictError extends ProjectTaskDomainError {
  public constructor() {
    super('PROJECT_TASK_ORDER_CONFLICT', 409, 'The project task order changed. Reload the latest order and try again.');
  }
}

export class ProjectTaskOrderBoundaryError extends ProjectTaskDomainError {
  public constructor() {
    super('PROJECT_TASK_ORDER_BOUNDARY', 409, 'This task is already at the requested end of the list.');
  }
}

export class ProjectTaskSuggestionResolvedError extends ProjectTaskDomainError {
  public constructor() {
    super('PROJECT_TASK_SUGGESTION_RESOLVED', 409, 'This suggestion was already resolved another way.');
  }
}
