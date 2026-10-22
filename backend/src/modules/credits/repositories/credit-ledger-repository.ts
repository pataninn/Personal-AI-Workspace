import type { CreditCallSourceKind, ProviderCallCreditReservation, ProviderCallPriceSnapshot, ProviderCallSettlementResult } from '@/modules/credits/repositories/provider-call-credit-admission';
import type { ProviderTokenUsage } from '@/modules/ai-runs/domain/ai-run-types';

export interface CreditReservationCommand {
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
  readonly maximumUnits: bigint;
}

export interface CreditSettlementCommand {
  readonly reservationId: string;
  readonly usage: ProviderTokenUsage;
  readonly estimated?: boolean;
}

export interface AccountTimeZoneChangeCommand {
  readonly ownerId: string;
  readonly timeZone: string;
}

export interface HomeTurnProviderCallUsageRow {
  readonly status: 'in_flight' | 'unknown' | 'settled' | 'released' | 'over_bound';
  readonly providerProfile: string;
  readonly model: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly chargedUnits: string;
    readonly estimated?: true;
  };
}

export interface ICreditLedgerRepository {
  reserveProviderCall(command: CreditReservationCommand): Promise<ProviderCallCreditReservation>;
  settleProviderCall(command: CreditSettlementCommand): Promise<ProviderCallSettlementResult>;
  retainUnknown(reservationId: string, reason: string): Promise<void>;
  releaseKnownNotSent(reservationId: string): Promise<void>;
  queueAccountTimeZoneChange(command: AccountTimeZoneChangeCommand): Promise<Date>;
  listHomeTurnProviderCallUsage(ownerId: string, homeTurnId: string): Promise<readonly HomeTurnProviderCallUsageRow[]>;
  retainHomeTurnInFlightCallsUnknown(ownerId: string, homeTurnId: string): Promise<number>;
}
