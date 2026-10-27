import type { ProviderTokenUsage } from '@/modules/ai-runs/domain/ai-run-types';

export type CreditCallSourceKind = 'ai_run' | 'home_turn';

export interface ProviderCallPriceSnapshot {
  readonly version: string;
  readonly inputUnitsPerMillionTokens: bigint;
  readonly outputUnitsPerMillionTokens: bigint;
}

export interface ProviderCallAdmissionRequest {
  readonly ownerId: string;
  readonly sourceKind: CreditCallSourceKind;
  readonly sourceId: string;
  readonly callId: string;
  readonly attemptId: string;
  readonly providerProfile: string;
  readonly model: string;
  readonly price: ProviderCallPriceSnapshot;
  readonly inputBounderVersion: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxAttemptsForSource: number;
}

export interface ProviderCallCreditReservation {
  readonly reservationId: string;
  readonly maximumUnits: bigint;
}

export type ProviderCallSettlementResult =
  | { readonly outcome: 'settled' | 'replayed' | 'over_bound'; readonly chargedUnits: bigint }
  | { readonly outcome: 'unknown'; readonly reason: 'usage_charge_overflow' };

/** Narrow application port used immediately before a billable provider send. */
export interface IProviderCallCreditAdmission {
  reserveBeforeSend(input: ProviderCallAdmissionRequest): Promise<ProviderCallCreditReservation>;
  settleReportedUsage(reservationId: string, usage: ProviderTokenUsage): Promise<ProviderCallSettlementResult>;
  retainUnknown(reservationId: string, reason: string): Promise<void>;
  releaseKnownNotSent(reservationId: string): Promise<void>;
}

export interface ProviderInputTokenBounder {
  readonly version: string;
  upperBound(input: {
    readonly model: string;
    readonly messages: readonly { readonly role: string; readonly content: string }[];
  }): Promise<number>;
}

export interface ProviderCallCreditConfiguration {
  readonly price: ProviderCallPriceSnapshot;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxAttemptsForSource: number;
}

export interface ProviderCallReservationInput {
  readonly request: Omit<ProviderCallAdmissionRequest, 'price' | 'maxInputTokens' | 'maxOutputTokens' | 'maxAttemptsForSource'>;
  readonly configuration: ProviderCallCreditConfiguration;
  readonly inputTokenUpperBound: number;
}
