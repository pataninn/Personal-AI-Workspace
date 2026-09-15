import type { ErrorDetail } from '@/shared/errors/app-error';

export class WorkspaceDomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: readonly ErrorDetail[];

  public constructor(
    code: string,
    statusCode: number,
    message: string,
    details: readonly ErrorDetail[] = []
  ) {
    super(message);
    this.name = 'WorkspaceDomainError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class WorkspacePathInvalidError extends WorkspaceDomainError {
  public constructor(field = 'path') {
    super('WORKSPACE_PATH_INVALID', 400, 'The workspace path is invalid.', [{
      field,
      message: 'Use a normalized relative path inside the selected project.'
    }]);
  }
}

export class WorkspacePathForbiddenError extends WorkspaceDomainError {
  public constructor() {
    super('WORKSPACE_PATH_FORBIDDEN', 403, 'This workspace path is not available for inspection.');
  }
}

export class WorkspacePathNotFoundError extends WorkspaceDomainError {
  public constructor() {
    super('WORKSPACE_PATH_NOT_FOUND', 404, 'The requested workspace entry was not found.');
  }
}

export class WorkspaceUnsupportedFileError extends WorkspaceDomainError {
  public constructor() {
    super('WORKSPACE_FILE_UNSUPPORTED', 415, 'This workspace file is not an approved text file.');
  }
}

export class WorkspaceBinaryFileError extends WorkspaceDomainError {
  public constructor() {
    super('WORKSPACE_FILE_BINARY', 415, 'This workspace file is not readable as UTF-8 text.');
  }
}

export class WorkspaceLimitExceededError extends WorkspaceDomainError {
  public constructor(message = 'The workspace inspection limit was exceeded.') {
    super('WORKSPACE_LIMIT_EXCEEDED', 413, message);
  }
}

export class WorkspaceReparsePointError extends WorkspaceDomainError {
  public constructor() {
    super('WORKSPACE_REPARSE_POINT', 403, 'This workspace entry cannot be inspected safely.');
  }
}

export class WorkspaceIoError extends WorkspaceDomainError {
  public constructor() {
    super('WORKSPACE_IO_FAILURE', 503, 'The workspace entry could not be inspected safely.');
  }
}

export class WorkspaceOperationCancelledError extends WorkspaceDomainError {
  public constructor() {
    super('WORKSPACE_OPERATION_CANCELLED', 408, 'The workspace inspection was cancelled.');
  }
}

export class WorkspaceOperationTimeoutError extends WorkspaceDomainError {
  public constructor() {
    super('WORKSPACE_OPERATION_TIMEOUT', 408, 'The workspace inspection timed out.');
  }
}
