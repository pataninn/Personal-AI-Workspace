import { AppError } from '@/shared/errors/app-error';

/** A legacy consent/approval decision is history only and cannot authorize work. */
export class PolicyActionRetiredError extends AppError {
  public constructor() {
    super('POLICY_ACTION_RETIRED', 409, 'This decision path is no longer available. Submit a fresh request if the action is supported.');
    this.name = 'PolicyActionRetiredError';
  }
}
