export class InvalidCredentialsError extends Error {
  public constructor() {
    super('The supplied local credentials were not accepted.');
    this.name = 'InvalidCredentialsError';
  }
}

export class SetupRequiredError extends Error {
  public constructor() {
    super('A local user must be configured before sign in is available.');
    this.name = 'SetupRequiredError';
  }
}

export class UnauthenticatedError extends Error {
  public constructor() {
    super('A valid local session is required.');
    this.name = 'UnauthenticatedError';
  }
}

export function isAuthError(error: unknown): error is InvalidCredentialsError | SetupRequiredError | UnauthenticatedError {
  return error instanceof InvalidCredentialsError
    || error instanceof SetupRequiredError
    || error instanceof UnauthenticatedError;
}
