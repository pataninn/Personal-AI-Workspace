import type { ErrorDetail } from '@/shared/errors/app-error';

export class ProjectFactDomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: readonly ErrorDetail[];

  public constructor(code: string, statusCode: number, message: string, details: readonly ErrorDetail[] = []) {
    super(message);
    this.name = 'ProjectFactDomainError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ProjectFactValidationError extends ProjectFactDomainError {
  public constructor(details: readonly ErrorDetail[]) {
    super('VALIDATION_ERROR', 400, 'The project fact is invalid.', details);
  }
}

export class ProjectFactNotFoundError extends ProjectFactDomainError {
  public constructor() {
    super('PROJECT_FACT_NOT_FOUND', 404, 'Project fact not found.');
  }
}

export class ProjectFactAlreadyExistsError extends ProjectFactDomainError {
  public constructor() {
    super('PROJECT_FACT_ALREADY_EXISTS', 409, 'A fact with this name already exists in this project.', [{ field: 'title', message: 'A fact with this name already exists in this project.' }]);
  }
}

export class ProjectFactVersionConflictError extends ProjectFactDomainError {
  public constructor() {
    super('PROJECT_FACT_VERSION_CONFLICT', 409, 'This fact changed before the request was applied. Reload the latest version and try again.');
  }
}

export class ProjectFactArchivedProjectError extends ProjectFactDomainError {
  public constructor() {
    super('PROJECT_ARCHIVED', 409, 'This project is archived. Its facts are read-only.');
  }
}

export class ProjectFactVersionRequiredError extends ProjectFactDomainError {
  public constructor() {
    super('PROJECT_FACT_VERSION_REQUIRED', 400, 'A current fact version is required.');
  }
}
