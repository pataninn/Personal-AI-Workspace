export interface ErrorDetail {
  readonly field: string;
  readonly message: string;
}

export class AppError extends Error {
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
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ConfigurationError extends Error {
  public readonly details: readonly ErrorDetail[];

  public constructor(message: string, details: readonly ErrorDetail[] = []) {
    super(message);
    this.name = 'ConfigurationError';
    this.details = details;
  }
}

export interface StartupCheckFailure {
  readonly check: 'database' | 'workspace' | 'openshell' | 'nim';
  readonly code: string;
  readonly message: string;
}

export class StartupChecksError extends Error {
  public readonly failures: readonly StartupCheckFailure[];

  public constructor(failures: readonly StartupCheckFailure[]) {
    super('Required startup checks did not pass.');
    this.name = 'StartupChecksError';
    this.failures = failures;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
