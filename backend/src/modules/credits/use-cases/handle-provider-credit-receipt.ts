import { ProviderCreditAdmissionDeniedError } from '@/modules/credits/domain/credit-errors';
import { HOME_NEBIUS_NEMOTRON_BOUND } from '@/modules/credits/domain/home-provider-credit-bound';
import type { CreditCallSourceKind, ProviderCallCreditConfiguration, IProviderCallCreditAdmission } from '@/modules/credits/repositories/provider-call-credit-admission';
import type { HomeProviderCreditRequest, HomeProviderCreditResult } from '@/modules/home-assistant/repositories/home-planning-runtime';
import type { IHomeProviderCreditReceiptHandler } from '@/modules/home-assistant/repositories/home-provider-credit-receipt-handler';
import type { ICreditLedgerRepository } from '@/modules/credits/repositories/credit-ledger-repository';

interface ProviderReservation {
  readonly reservationId: string;
  readonly inputTokens: number;
  completed: boolean;
}

/** Calls the existing Credits admission and settlement boundary for every trusted Hermes bridge receipt. */
export class HandleProviderCreditReceiptUseCase implements IHomeProviderCreditReceiptHandler {
  private readonly reservations = new Map<string, Map<string, ProviderReservation>>();
  private readonly admittedTurns = new Set<string>();

  public constructor(
    private readonly admission: IProviderCallCreditAdmission,
    private readonly configuration: ProviderCallCreditConfiguration | undefined,
    private readonly provider: { readonly profile: string; readonly model: string },
    private readonly ledger: Pick<ICreditLedgerRepository, 'retainHomeTurnInFlightCallsUnknown' | 'settleProviderCall'>,
    private readonly allowEstimatedUsage = false,
    private readonly sourceKind: CreditCallSourceKind = 'home_turn'
  ) {}

  public hasAdmittedCall(turnId: string): boolean { return this.admittedTurns.has(turnId); }

  public clearTurn(turnId: string): void {
    this.reservations.delete(turnId);
    this.admittedTurns.delete(turnId);
  }

  public async markInterrupted(ownerId: string, turnId: string): Promise<void> {
    if (this.sourceKind === 'home_turn') await this.ledger.retainHomeTurnInFlightCallsUnknown(ownerId, turnId);
    else for (const reservation of this.reservations.get(turnId)?.values() ?? []) {
      if (!reservation.completed) await this.admission.retainUnknown(reservation.reservationId, 'workspace_run_interrupted');
    }
    if (this.allowEstimatedUsage) {
      for (const reservation of this.reservations.get(turnId)?.values() ?? []) {
        if (!reservation.completed) await this.settleEstimate(reservation);
      }
    }
  }

  public async handle(input: { readonly ownerId: string; readonly turnId: string; readonly providerProfile: string; readonly model: string; readonly request: HomeProviderCreditRequest }): Promise<HomeProviderCreditResult> {
    if (!this.configuration || input.providerProfile !== this.provider.profile || input.model !== this.provider.model) {
      return { outcome: 'denied', code: 'ADMISSION_UNAVAILABLE' };
    }
    const key = `${input.request.callId}:${input.request.attemptId}`;
    if (input.request.operation === 'reserve') {
      if (this.provider.profile !== HOME_NEBIUS_NEMOTRON_BOUND.providerProfile
        || this.provider.model !== HOME_NEBIUS_NEMOTRON_BOUND.model
        || this.configuration.maxInputTokens < HOME_NEBIUS_NEMOTRON_BOUND.maxInputTokens
        || input.request.providerProfile !== this.provider.profile || input.request.model !== this.provider.model
        || input.request.inputBounderVersion !== 'hermes-json-utf8-v1'
        || !Number.isSafeInteger(input.request.inputTokenUpperBound) || input.request.inputTokenUpperBound < 1) {
        return { outcome: 'denied', code: 'ADMISSION_UNAVAILABLE' };
      }
      const turnReservations = this.reservations.get(input.turnId) ?? new Map<string, ProviderReservation>();
      const existing = turnReservations.get(key);
      if (existing) return { outcome: 'reserved', reservationId: existing.reservationId };
      try {
        const reservation = await this.admission.reserveBeforeSend({
          ownerId: input.ownerId,
          sourceKind: this.sourceKind,
          sourceId: input.turnId,
          callId: input.request.callId,
          attemptId: input.request.attemptId,
          providerProfile: this.provider.profile,
          model: this.provider.model,
          price: this.configuration.price,
          inputBounderVersion: HOME_NEBIUS_NEMOTRON_BOUND.version,
          maxInputTokens: HOME_NEBIUS_NEMOTRON_BOUND.maxInputTokens,
          maxOutputTokens: Math.min(this.configuration.maxOutputTokens, HOME_NEBIUS_NEMOTRON_BOUND.maxOutputTokens),
          maxAttemptsForSource: this.configuration.maxAttemptsForSource
        });
        turnReservations.set(key, {
          reservationId: reservation.reservationId,
          completed: false,
          // shortcut: UTF-8 request bytes plus overhead estimate input; use the provider tokenizer when available.
          inputTokens: Math.min(input.request.inputTokenUpperBound, HOME_NEBIUS_NEMOTRON_BOUND.maxInputTokens)
        });
        this.reservations.set(input.turnId, turnReservations);
        this.admittedTurns.add(input.turnId);
        return { outcome: 'reserved', reservationId: reservation.reservationId };
      } catch (error: unknown) {
        return { outcome: 'denied', code: error instanceof ProviderCreditAdmissionDeniedError && error.reason === 'limit_exceeded'
          ? 'BUDGET_EXHAUSTED' : 'ADMISSION_UNAVAILABLE' };
      }
    }

    const expectedReservation = this.reservations.get(input.turnId)?.get(key);
    if (!expectedReservation || expectedReservation.reservationId !== input.request.reservationId) return { outcome: 'unknown' };
    try {
      if (input.request.operation === 'settle') {
        const result = await this.admission.settleReportedUsage(expectedReservation.reservationId, input.request.usage);
        if (result.outcome === 'unknown') return { outcome: 'unknown' };
        expectedReservation.completed = true;
        return { outcome: 'settled', status: result.outcome === 'over_bound' ? 'over_bound' : 'settled' };
      }
      if (input.request.operation === 'unknown') {
        if (this.allowEstimatedUsage) return await this.settleEstimate(expectedReservation);
        await this.admission.retainUnknown(expectedReservation.reservationId, input.request.reason ?? 'provider_outcome_unknown');
        return { outcome: 'unknown' };
      }
      await this.admission.releaseKnownNotSent(expectedReservation.reservationId);
      expectedReservation.completed = true;
      return { outcome: 'released' };
    } catch {
      if (input.request.operation !== 'release') {
        await this.admission.retainUnknown(expectedReservation.reservationId, 'provider_receipt_failed').catch(() => undefined);
      }
      return { outcome: 'unknown' };
    }
  }

  private async settleEstimate(reservation: ProviderReservation): Promise<HomeProviderCreditResult> {
    const result = await this.ledger.settleProviderCall({
      reservationId: reservation.reservationId,
      usage: { promptTokens: reservation.inputTokens, completionTokens: Math.min(this.configuration?.maxOutputTokens ?? HOME_NEBIUS_NEMOTRON_BOUND.maxOutputTokens, HOME_NEBIUS_NEMOTRON_BOUND.maxOutputTokens) },
      estimated: true
    });
    if (result.outcome === 'unknown') return { outcome: 'unknown' };
    reservation.completed = true;
    return { outcome: 'settled', status: result.outcome === 'over_bound' ? 'over_bound' : 'settled' };
  }
}
