import { NEBIUS_PROVIDER_PROFILE } from '@/modules/ai-runs/domain/model-provider-profile';
import type { CreditCallSourceKind, IProviderCallCreditAdmission, ProviderCallCreditConfiguration } from '@/modules/credits/repositories/provider-call-credit-admission';
import { HandleHomeProviderCreditReceiptUseCase } from '@/modules/credits/use-cases/handle-home-provider-credit-receipt';
import type { HomeProviderCreditRequest } from '@/modules/home-assistant/repositories/home-planning-runtime';

const MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const configuration: ProviderCallCreditConfiguration = {
  price: { version: 'price-v1', inputUnitsPerMillionTokens: 300_000n, outputUnitsPerMillionTokens: 900_000n },
  maxInputTokens: 262_144,
  maxOutputTokens: 512,
  maxAttemptsForSource: 1
};

function setup(maxInputTokens = configuration.maxInputTokens, allowEstimatedUsage = false, sourceKind: CreditCallSourceKind = 'home_turn') {
  const admission: jest.Mocked<IProviderCallCreditAdmission> = {
    reserveBeforeSend: jest.fn().mockResolvedValue({ reservationId: 'reservation-1', maximumUnits: 79_105n }),
    settleReportedUsage: jest.fn().mockResolvedValue({ outcome: 'settled', chargedUnits: 1n }),
    retainUnknown: jest.fn().mockResolvedValue(undefined),
    releaseKnownNotSent: jest.fn().mockResolvedValue(undefined)
  };
  const ledger = { retainHomeTurnInFlightCallsUnknown: jest.fn().mockResolvedValue(undefined), settleProviderCall: jest.fn().mockResolvedValue({ outcome: 'settled', chargedUnits: 768n }) };
  const useCase = new HandleHomeProviderCreditReceiptUseCase(admission, {
    ...configuration,
    maxInputTokens
  }, { profile: NEBIUS_PROVIDER_PROFILE, model: MODEL }, ledger, allowEstimatedUsage, sourceKind);

  return { admission, useCase, ledger };
}

const reservationRequest: HomeProviderCreditRequest = {
  operation: 'reserve',
  callId: 'call-1',
  attemptId: 'attempt-1',
  providerProfile: NEBIUS_PROVIDER_PROFILE,
  model: MODEL,
  inputTokenUpperBound: 1024,
  inputBounderVersion: 'hermes-json-utf8-v1'
};

describe('HandleHomeProviderCreditReceiptUseCase', () => {
  it('reserves the full pinned context bound regardless of the bridge byte estimate', async () => {
    const { admission, useCase } = setup();

    await expect(useCase.handle({
      ownerId: 'owner-1', turnId: 'turn-1', providerProfile: NEBIUS_PROVIDER_PROFILE, model: MODEL, request: reservationRequest
    })).resolves.toEqual({ outcome: 'reserved', reservationId: 'reservation-1' });
    expect(admission.reserveBeforeSend).toHaveBeenCalledWith(expect.objectContaining({
      inputBounderVersion: 'nebius-nemotron-context-v1',
      maxInputTokens: 262_144,
      maxOutputTokens: 512,
      maxAttemptsForSource: 1
    }));
  });

  it('denies Home admission when configuration cannot reserve the full context', async () => {
    const { admission, useCase } = setup(262_143);

    await expect(useCase.handle({
      ownerId: 'owner-1', turnId: 'turn-1', providerProfile: NEBIUS_PROVIDER_PROFILE, model: MODEL, request: reservationRequest
    })).resolves.toEqual({ outcome: 'denied', code: 'ADMISSION_UNAVAILABLE' });
    expect(admission.reserveBeforeSend).not.toHaveBeenCalled();
  });

  it('denies receipts for any provider or model outside the pinned route', async () => {
    const { admission, useCase } = setup();
    const wrongProfile = { ...reservationRequest, providerProfile: 'nvidia-hosted-nim' } as const;
    const wrongModel = { ...reservationRequest, model: 'other-model' } as const;

    for (const request of [wrongProfile, wrongModel]) {
      await expect(useCase.handle({
        ownerId: 'owner-1', turnId: 'turn-1', providerProfile: NEBIUS_PROVIDER_PROFILE, model: MODEL, request
      })).resolves.toEqual({ outcome: 'denied', code: 'ADMISSION_UNAVAILABLE' });
    }
    expect(admission.reserveBeforeSend).not.toHaveBeenCalled();
  });
});

const receiptInput = { ownerId: 'owner-1', turnId: 'turn-1', providerProfile: NEBIUS_PROVIDER_PROFILE, model: MODEL };

describe('optional Home estimated usage', () => {
  it('keeps missing receipts unknown by default', async () => {
    const { useCase, admission, ledger } = setup();
    await useCase.handle({ ...receiptInput, request: reservationRequest });
    await expect(useCase.handle({ ...receiptInput, request: { operation: 'unknown', callId: 'call-1', attemptId: 'attempt-1', reservationId: 'reservation-1' } })).resolves.toEqual({ outcome: 'unknown' });
    expect(admission.retainUnknown).toHaveBeenCalled();
    expect(ledger.settleProviderCall).not.toHaveBeenCalled();
  });

  it('settles missing usage with byte-based input and the capped output estimate when enabled', async () => {
    const { useCase, ledger } = setup(262144, true);
    await useCase.handle({ ...receiptInput, request: reservationRequest });
    await expect(useCase.handle({ ...receiptInput, request: { operation: 'unknown', callId: 'call-1', attemptId: 'attempt-1', reservationId: 'reservation-1' } })).resolves.toEqual({ outcome: 'settled', status: 'settled' });
    expect(ledger.settleProviderCall).toHaveBeenCalledWith({ reservationId: 'reservation-1', usage: { promptTokens: 1024, completionTokens: 512 }, estimated: true });
  });

  it('preserves provider usage without estimating a completed call again', async () => {
    const { useCase, admission, ledger } = setup(262144, true);
    await useCase.handle({ ...receiptInput, request: reservationRequest });
    await useCase.handle({ ...receiptInput, request: { operation: 'settle', callId: 'call-1', attemptId: 'attempt-1', reservationId: 'reservation-1', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } } });
    expect(admission.settleReportedUsage).toHaveBeenCalledWith('reservation-1', { promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    await useCase.markInterrupted('owner-1', 'turn-1');
    expect(ledger.settleProviderCall).not.toHaveBeenCalled();
  });

  it('settles an interrupted call using an estimate once', async () => {
    const { useCase, ledger } = setup(262144, true);
    await useCase.handle({ ...receiptInput, request: reservationRequest });
    await useCase.markInterrupted('owner-1', 'turn-1');
    await useCase.markInterrupted('owner-1', 'turn-1');
    expect(ledger.settleProviderCall).toHaveBeenCalledTimes(1);
    expect(ledger.settleProviderCall).toHaveBeenCalledWith(expect.objectContaining({ estimated: true }));
  });

  it('retains unknown if estimate settlement fails and rejects mismatched reservation IDs', async () => {
    const { useCase, admission, ledger } = setup(262144, true);
    await useCase.handle({ ...receiptInput, request: reservationRequest });
    ledger.settleProviderCall.mockRejectedValue(new Error('ledger unavailable'));
    await expect(useCase.handle({ ...receiptInput, request: { operation: 'unknown', callId: 'call-1', attemptId: 'attempt-1', reservationId: 'reservation-1' } })).resolves.toEqual({ outcome: 'unknown' });
    expect(admission.retainUnknown).toHaveBeenCalledWith('reservation-1', 'provider_receipt_failed');
    ledger.settleProviderCall.mockClear();
    await useCase.handle({ ...receiptInput, request: { operation: 'unknown', callId: 'call-1', attemptId: 'attempt-1', reservationId: 'other' } });
    expect(ledger.settleProviderCall).not.toHaveBeenCalled();
  });
});


it('meters workspace AI runs under their own source kind and estimates interruption', async () => {
  const { useCase, admission, ledger } = setup(262144, true, 'ai_run');
  await useCase.handle({ ...receiptInput, request: reservationRequest });
  expect(admission.reserveBeforeSend).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: 'ai_run', sourceId: 'turn-1' }));
  await useCase.markInterrupted('owner-1', 'turn-1');
  expect(ledger.retainHomeTurnInFlightCallsUnknown).not.toHaveBeenCalled();
  expect(admission.retainUnknown).toHaveBeenCalledWith('reservation-1', 'workspace_run_interrupted');
  expect(ledger.settleProviderCall).toHaveBeenCalledWith(expect.objectContaining({ estimated: true }));
});
