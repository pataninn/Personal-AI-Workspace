export type CreditDenialReason =
  | 'paused'
  | 'unconfigured'
  | 'missing_bound'
  | 'limit_exceeded'
  | 'account_inactive'
  | 'duplicate_attempt'
  | 'call_limit_exceeded'
  | 'ledger_unavailable';

export class ProviderCreditAdmissionDeniedError extends Error {
  public constructor(public readonly reason: CreditDenialReason) {
    super('AI usage controls are unavailable or spending is paused.');
    this.name = 'ProviderCreditAdmissionDeniedError';
  }
}

export class ProviderCreditUsageInvalidError extends Error {
  public constructor() {
    super('The provider usage report could not be reconciled safely.');
    this.name = 'ProviderCreditUsageInvalidError';
  }
}
