import type { ErrorDetail } from '@/shared/errors/app-error';

export class ProjectDomainError extends Error {
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
    this.name = 'ProjectDomainError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ProjectNameInvalidError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_NAME_INVALID', 400, 'The project name is invalid.', [{
      field: 'name',
      message: 'Enter a project name.'
    }]);
  }
}

export class ProjectRootInvalidError extends ProjectDomainError {
  public constructor(message = 'Use a relative folder beneath the configured workspace.') {
    super('PROJECT_ROOT_INVALID', 400, message, [{
      field: 'relativeRoot',
      message
    }]);
  }
}

export class ProjectRootProtectedError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_ROOT_PROTECTED', 400, 'This folder is protected and cannot be used as a project root.', [{
      field: 'relativeRoot',
      message: 'This folder cannot be used as a project root. Choose a normal child folder inside the workspace.'
    }]);
  }
}

export class ProjectRootReparsePointError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_ROOT_REPARSE_POINT', 400, 'This folder cannot be used as a project root.', [{
      field: 'relativeRoot',
      message: 'This folder cannot be used as a project root. Choose a normal child folder inside the workspace.'
    }]);
  }
}

export class ProjectRootNotFoundError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_ROOT_NOT_FOUND', 400, 'The project folder does not exist.', [{
      field: 'relativeRoot',
      message: 'Choose an existing folder inside the workspace.'
    }]);
  }
}

export class ProjectRootOverlapError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_ROOT_OVERLAP', 409, 'This folder is already used by another active project.', [{
      field: 'relativeRoot',
      message: 'This folder is already used by another active project. Choose a different relative root.'
    }]);
  }
}

export class ProjectRootNotAttachedError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_ROOT_NOT_ATTACHED', 409, 'Attach a project folder before using file access or assistant runs.');
  }
}

export class ProjectWorkspaceModeInvalidError extends ProjectDomainError {
  public constructor(message = 'Choose planning mode without a folder, or provide a folder for file-backed mode.') {
    super('PROJECT_WORKSPACE_MODE_INVALID', 400, message, [{ field: 'workspaceMode', message }]);
  }
}

export class ProjectObjectiveInvalidError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_OBJECTIVE_INVALID', 400, 'The project objective is invalid.', [{
      field: 'objective',
      message: 'Use a project objective with at most 2,000 characters.'
    }]);
  }
}

export class ProjectNameConflictError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_NAME_CONFLICT', 409, 'An active project with this name already exists.', [{
      field: 'name',
      message: 'Choose a different project name.'
    }]);
  }
}

export class ProjectNotFoundError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_NOT_FOUND', 404, 'Project not found.');
  }
}

export class ProjectVersionConflictError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_VERSION_CONFLICT', 409, 'The project changed before this request was applied.');
  }
}

export class ProjectStatusInvalidError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_STATUS_INVALID', 400, 'The project status is invalid.', [{
      field: 'status',
      message: 'Status must be active or archived.'
    }]);
  }
}

export class ProjectVersionRequiredError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_VERSION_REQUIRED', 400, 'If-Match is required for project changes and removal.');
  }
}

export class ProjectRemovalBusyError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_REMOVAL_BUSY', 409, 'Finish or resolve assistant runs, file changes, and commands before removing this project.');
  }
}

export class ProjectRecoveryCleanupError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_RECOVERY_CLEANUP_FAILED', 503, 'Private project history could not be safely removed.');
  }
}

export class ProjectRemovalCleanupPendingError extends ProjectDomainError {
  public constructor() {
    super('PROJECT_REMOVAL_CLEANUP_PENDING', 503, 'The project record was removed, but private history cleanup is pending. Restart the app to retry cleanup.');
  }
}

export class WorkspaceBoundaryUnavailableError extends ProjectDomainError {
  public constructor() {
    super('WORKSPACE_BOUNDARY_UNAVAILABLE', 503, 'The authoritative workspace is unavailable, so this project operation cannot proceed safely.');
  }
}
