import { maximumCreditUnits } from '@/modules/credits/domain/credit-calculation';
import { ProviderCreditAdmissionDeniedError, ProviderCreditUsageInvalidError } from '@/modules/credits/domain/credit-errors';
import type { ICreditLedgerRepository } from '@/modules/credits/repositories/credit-ledger-repository';
import type {
  IProviderCallCreditAdmission,
  ProviderCallAdmissionRequest,
  ProviderCallCreditReservation,
  ProviderCallSettlementResult
} from '@/modules/credits/repositories/provider-call-credit-admission';
import type { ProviderTokenUsage } from '@/modules/ai-runs/domain/ai-run-types';

export class ProviderCallCreditAdmission implements IProviderCallCreditAdmission {
  public constructor(private readonly ledger: ICreditLedgerRepository) {}

  public async reserveBeforeSend(input: ProviderCallAdmissionRequest): Promise<ProviderCallCreditReservation> {
    validateAdmission(input);
    const maximumUnits = maximumCreditUnits(
      { inputTokens: input.maxInputTokens, outputTokens: input.maxOutputTokens },
      { inputUnitsPerMillionTokens: input.price.inputUnitsPerMillionTokens, outputUnitsPerMillionTokens: input.price.outputUnitsPerMillionTokens }
    );
    try {
      return await this.ledger.reserveProviderCall({ ...input, maximumUnits });
    } catch (error: unknown) {
      if (error instanceof ProviderCreditAdmissionDeniedError) throw error;
      throw new ProviderCreditAdmissionDeniedError('ledger_unavailable');
    }
  }

  public async settleReportedUsage(reservationId: string, usage: ProviderTokenUsage): Promise<ProviderCallSettlementResult> {
    const counts = completeUsage(usage);
    if (!counts) {
      await this.ledger.retainUnknown(reservationId, 'provider_usage_incomplete');
      throw new ProviderCreditUsageInvalidError();
    }
    try {
      return await this.ledger.settleProviderCall({ reservationId, usage: counts });
    } catch (error: unknown) {
      await this.ledger.retainUnknown(reservationId, 'settlement_unavailable').catch(() => undefined);
      throw error;
    }
  }

  public retainUnknown(reservationId: string, reason: string): Promise<void> {
    return this.ledger.retainUnknown(reservationId, sanitizeUnknownReason(reason));
  }

  public releaseKnownNotSent(reservationId: string): Promise<void> {
    return this.ledger.releaseKnownNotSent(reservationId);
  }
}

function validateAdmission(input: ProviderCallAdmissionRequest): void {
  const safeIdentity = (value: string): boolean => typeof value === 'string' && value.length > 0 && value.length <= 128;
  if (!safeIdentity(input.ownerId) || !safeIdentity(input.sourceId) || !safeIdentity(input.callId) || !safeIdentity(input.attemptId)
    || !safeIdentity(input.providerProfile) || !safeIdentity(input.model) || !safeIdentity(input.price.version)
    || !safeIdentity(input.inputBounderVersion)
    || !Number.isSafeInteger(input.maxInputTokens) || input.maxInputTokens < 1
    || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1
    || !Number.isSafeInteger(input.maxAttemptsForSource) || input.maxAttemptsForSource < 1 || input.maxAttemptsForSource > 32
    || input.price.inputUnitsPerMillionTokens < 1n || input.price.outputUnitsPerMillionTokens < 1n) {
    throw new ProviderCreditAdmissionDeniedError('missing_bound');
  }
  try {
    maximumCreditUnits(
      { inputTokens: input.maxInputTokens, outputTokens: input.maxOutputTokens },
      { inputUnitsPerMillionTokens: input.price.inputUnitsPerMillionTokens, outputUnitsPerMillionTokens: input.price.outputUnitsPerMillionTokens }
    );
  } catch {
    throw new ProviderCreditAdmissionDeniedError('missing_bound');
  }
}

function completeUsage(usage: ProviderTokenUsage): ProviderTokenUsage | undefined {
  const inputTokens = usage.promptTokens;
  const outputTokens = usage.completionTokens;
  const totalTokens = usage.totalTokens;
  if (!Number.isSafeInteger(inputTokens) || inputTokens === undefined || inputTokens < 0
    || !Number.isSafeInteger(outputTokens) || outputTokens === undefined || outputTokens < 0
    || (totalTokens !== undefined && (!Number.isSafeInteger(totalTokens) || totalTokens < 0 || totalTokens !== inputTokens + outputTokens))) {
    return undefined;
  }
  return { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens };
}

function sanitizeUnknownReason(reason: string): string {
  return /^[a-z0-9_-]{1,64}$/u.test(reason) ? reason : 'provider_outcome_unknown';
}
