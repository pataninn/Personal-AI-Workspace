import { ProviderCreditAdmissionDeniedError } from '@/modules/credits/domain/credit-errors';
import type { ProviderCallCreditConfiguration, IProviderCallCreditAdmission } from '@/modules/credits/repositories/provider-call-credit-admission';
import type { HomeProviderCreditRequest, HomeProviderCreditResult } from '@/modules/home-assistant/repositories/home-planning-runtime';
import type { IHomeProviderCreditReceiptHandler } from '@/modules/home-assistant/repositories/home-provider-credit-receipt-handler';
import type { ICreditLedgerRepository } from '@/modules/credits/repositories/credit-ledger-repository';

/** Calls the existing Credits admission and settlement boundary for every trusted Home bridge receipt. */
export class HandleHomeProviderCreditReceiptUseCase implements IHomeProviderCreditReceiptHandler {
  private readonly reservations = new Map<string, Map<string, string>>();
  private readonly admittedTurns = new Set<string>();

  public constructor(
    private readonly admission: IProviderCallCreditAdmission,
    private readonly configuration: ProviderCallCreditConfiguration | undefined,
    private readonly provider: { readonly profile: string; readonly model: string },
    private readonly ledger: Pick<ICreditLedgerRepository, 'retainHomeTurnInFlightCallsUnknown'>
  ) {}

  public hasAdmittedCall(turnId: string): boolean { return this.admittedTurns.has(turnId); }

  public clearTurn(turnId: string): void {
    this.reservations.delete(turnId);
    this.admittedTurns.delete(turnId);
  }

  public async markInterrupted(ownerId: string, turnId: string): Promise<void> {
    await this.ledger.retainHomeTurnInFlightCallsUnknown(ownerId, turnId);
  }

  public async handle(input: { readonly ownerId: string; readonly turnId: string; readonly providerProfile: string; readonly model: string; readonly request: HomeProviderCreditRequest }): Promise<HomeProviderCreditResult> {
    if (!this.configuration || input.providerProfile !== this.provider.profile || input.model !== this.provider.model) {
      return { outcome: 'denied', code: 'ADMISSION_UNAVAILABLE' };
    }
    const key = `${input.request.callId}:${input.request.attemptId}`;
    if (input.request.operation === 'reserve') {
      if (input.request.providerProfile !== this.provider.profile || input.request.model !== this.provider.model
        || input.request.inputBounderVersion !== 'hermes-json-utf8-v1'
        || input.request.inputTokenUpperBound > this.configuration.maxInputTokens) {
        return { outcome: 'denied', code: 'ADMISSION_UNAVAILABLE' };
      }
      const turnReservations = this.reservations.get(input.turnId) ?? new Map<string, string>();
      const existing = turnReservations.get(key);
      if (existing) return { outcome: 'reserved', reservationId: existing };
      try {
        const reservation = await this.admission.reserveBeforeSend({
          ownerId: input.ownerId,
          sourceKind: 'home_turn',
          sourceId: input.turnId,
          callId: input.request.callId,
          attemptId: input.request.attemptId,
          providerProfile: this.provider.profile,
          model: this.provider.model,
          price: this.configuration.price,
          inputBounderVersion: input.request.inputBounderVersion,
          maxInputTokens: input.request.inputTokenUpperBound,
          maxOutputTokens: this.configuration.maxOutputTokens,
          maxAttemptsForSource: this.configuration.maxAttemptsForSource
        });
        turnReservations.set(key, reservation.reservationId);
        this.reservations.set(input.turnId, turnReservations);
        this.admittedTurns.add(input.turnId);
        return { outcome: 'reserved', reservationId: reservation.reservationId };
      } catch (error: unknown) {
        return { outcome: 'denied', code: error instanceof ProviderCreditAdmissionDeniedError && error.reason === 'limit_exceeded'
          ? 'BUDGET_EXHAUSTED' : 'ADMISSION_UNAVAILABLE' };
      }
    }

    const expectedReservation = this.reservations.get(input.turnId)?.get(key);
    if (!expectedReservation || expectedReservation !== input.request.reservationId) return { outcome: 'unknown' };
    try {
      if (input.request.operation === 'settle') {
        const result = await this.admission.settleReportedUsage(expectedReservation, input.request.usage);
        if (result.outcome === 'unknown') return { outcome: 'unknown' };
        return { outcome: 'settled', status: result.outcome === 'over_bound' ? 'over_bound' : 'settled' };
      }
      if (input.request.operation === 'unknown') {
        await this.admission.retainUnknown(expectedReservation, input.request.reason ?? 'provider_outcome_unknown');
        return { outcome: 'unknown' };
      }
      await this.admission.releaseKnownNotSent(expectedReservation);
      return { outcome: 'released' };
    } catch {
      if (input.request.operation !== 'release') {
        await this.admission.retainUnknown(expectedReservation, 'provider_receipt_failed').catch(() => undefined);
      }
      return { outcome: 'unknown' };
    }
  }
}
