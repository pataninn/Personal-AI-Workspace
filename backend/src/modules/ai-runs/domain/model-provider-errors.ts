import type { ErrorDetail } from '@/shared/errors/app-error';

export class ModelProviderError extends Error {
  public readonly code: string;
  public readonly details: readonly ErrorDetail[];

  public constructor(code: string, message: string, details: readonly ErrorDetail[] = []) {
    super(message);
    this.name = 'ModelProviderError';
    this.code = code;
    this.details = details;
  }
}

export class ModelProviderConfigurationError extends ModelProviderError {
  public constructor() {
    super('PROVIDER_CONFIGURATION_INVALID', 'The configured NVIDIA provider is unavailable.');
  }
}

export class ModelProviderUnavailableError extends ModelProviderError {
  public constructor() {
    super('PROVIDER_UNAVAILABLE', 'The configured NVIDIA provider is unavailable.');
  }
}

export class ModelProviderRequestError extends ModelProviderError {
  public constructor() {
    super('PROVIDER_REQUEST_FAILED', 'The NVIDIA provider could not complete this request.');
  }
}

export class ModelProviderOutputError extends ModelProviderError {
  public constructor() {
    super('PROVIDER_OUTPUT_INVALID', 'The NVIDIA provider returned an invalid response.');
  }
}

export class ModelProviderTimeoutError extends ModelProviderError {
  public constructor() {
    super('PROVIDER_TIMEOUT', 'The NVIDIA provider did not respond within the safe time limit.');
  }
}
