import { AppError } from '@/shared/errors/app-error';

export class AssistantExecutionUnavailableError extends AppError {
  public constructor() {
    super('ASSISTANT_EXECUTION_UNAVAILABLE', 503, 'Assistant execution is unavailable for this scope. No provider request was sent.');
    this.name = 'AssistantExecutionUnavailableError';
  }
}

export class AssistantExecutionPolicyChangedError extends AppError {
  public constructor() {
    super('EXECUTION_POLICY_CHANGED', 409, 'The execution policy changed. Refresh the scope status before submitting again.');
    this.name = 'AssistantExecutionPolicyChangedError';
  }
}
