import type { ErrorDetail } from '@/shared/errors/app-error';

export const PROVIDER_TRUNCATED_MESSAGE = 'NVIDIA reached the response length limit before finishing. Ask for fewer files or a smaller step; no changes from this response were applied.';

const PROVIDER_HTTP_FAILURES: Readonly<Record<number, string>> = {
  400: 'NVIDIA rejected the request format (HTTP 400). Check the configured model and request settings.',
  401: 'NVIDIA rejected the API key (HTTP 401). Check the configured credential.',
  403: 'NVIDIA denied access to this model (HTTP 403). Check your provider permissions.',
  429: 'NVIDIA rate or quota limit reached (HTTP 429). Wait before trying again and check your provider quota.',
  500: 'NVIDIA had a server error (HTTP 500). Try again later.',
  502: 'NVIDIA had a gateway error (HTTP 502). Try again later.',
  503: 'NVIDIA is temporarily unavailable (HTTP 503). Try again later.',
  504: 'NVIDIA timed out at its gateway (HTTP 504). Try a smaller request later.'
};

export function providerRejectionMessage(status: number): string {
  return PROVIDER_HTTP_FAILURES[status] ?? 'The NVIDIA provider rejected the request.';
}

/** Only application-owned messages may be saved; provider bodies can contain secrets. */
export function safeProviderFailureMessage(message: string): string {
  if (message === 'The NVIDIA provider returned an invalid response.') {
    return 'NVIDIA returned a response the app could not validate. Try asking for one smaller step. No changes from this response were applied.';
  }
  if (message === PROVIDER_TRUNCATED_MESSAGE || Object.values(PROVIDER_HTTP_FAILURES).includes(message)
    || ['The NVIDIA provider rejected the request.', 'The approved provider request exceeded the safe size limit.', 'The approved provider context is unavailable.', 'The provider request could not be completed safely.'].includes(message)) {
    return message;
  }
  return 'The assistant could not complete this run.';
}

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
