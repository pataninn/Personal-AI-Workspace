import { ProviderCreditAdmissionDeniedError, ProviderCreditUsageInvalidError } from '@/modules/credits/domain/credit-errors';
import type { ICreditLedgerRepository } from '@/modules/credits/repositories/credit-ledger-repository';
import { ProviderCallCreditAdmission } from '@/modules/credits/use-cases/provider-call-credit-admission';

function ledger(): jest.Mocked<ICreditLedgerRepository> {
  return {
    reserveProviderCall: jest.fn().mockResolvedValue({ reservationId: 'reservation-1', maximumUnits: 4n }),
    settleProviderCall: jest.fn().mockResolvedValue({ outcome: 'settled', chargedUnits: 2n }),
    retainUnknown: jest.fn().mockResolvedValue(undefined),
    releaseKnownNotSent: jest.fn().mockResolvedValue(undefined),
    queueAccountTimeZoneChange: jest.fn().mockResolvedValue(new Date('2026-10-20T00:00:00Z')),
    listHomeTurnProviderCallUsage: jest.fn().mockResolvedValue([]),
    retainHomeTurnInFlightCallsUnknown: jest.fn().mockResolvedValue(0)
  };
}

const request = {
  ownerId: 'a'.repeat(36), sourceKind: 'ai_run' as const, sourceId: 'b'.repeat(36), callId: 'primary', attemptId: '1',
  providerProfile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b',
  price: { version: 'offline-v1', inputUnitsPerMillionTokens: 1_000_000n, outputUnitsPerMillionTokens: 2_000_000n },
  inputBounderVersion: 'fixture-v1', maxInputTokens: 2, maxOutputTokens: 1, maxAttemptsForSource: 1
};

describe('ProviderCallCreditAdmission', () => {
  it('reserves the maximum integer cost through the ledger before returning admission', async () => {
    const repository = ledger();
    const service = new ProviderCallCreditAdmission(repository);
    await expect(service.reserveBeforeSend(request)).resolves.toEqual({ reservationId: 'reservation-1', maximumUnits: 4n });
    expect(repository.reserveProviderCall).toHaveBeenCalledWith({ ...request, maximumUnits: 4n });
  });

  it('fails closed when the price, hard bound, or provider identity is missing', async () => {
    const repository = ledger();
    const service = new ProviderCallCreditAdmission(repository);
    await expect(service.reserveBeforeSend({ ...request, inputBounderVersion: '' })).rejects.toBeInstanceOf(ProviderCreditAdmissionDeniedError);
    await expect(service.reserveBeforeSend({ ...request, price: { ...request.price, inputUnitsPerMillionTokens: 0n } })).rejects.toBeInstanceOf(ProviderCreditAdmissionDeniedError);
    await expect(service.reserveBeforeSend({ ...request, maxInputTokens: Number.MAX_SAFE_INTEGER + 1 })).rejects.toBeInstanceOf(ProviderCreditAdmissionDeniedError);
    expect(repository.reserveProviderCall).not.toHaveBeenCalled();
  });

  it('normalizes complete reported usage and delegates idempotent settlement', async () => {
    const repository = ledger();
    const service = new ProviderCallCreditAdmission(repository);
    await expect(service.settleReportedUsage('reservation-1', { promptTokens: 3, completionTokens: 5, totalTokens: 8 }))
      .resolves.toEqual({ outcome: 'settled', chargedUnits: 2n });
    expect(repository.settleProviderCall).toHaveBeenCalledWith({ reservationId: 'reservation-1', usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 } });
  });

  it('retains the reservation for partial or inconsistent usage', async () => {
    const repository = ledger();
    const service = new ProviderCallCreditAdmission(repository);
    await expect(service.settleReportedUsage('reservation-1', { completionTokens: 5 })).rejects.toBeInstanceOf(ProviderCreditUsageInvalidError);
    await expect(service.settleReportedUsage('reservation-1', { promptTokens: 3, completionTokens: 5, totalTokens: 99 })).rejects.toBeInstanceOf(ProviderCreditUsageInvalidError);
    expect(repository.retainUnknown).toHaveBeenCalledTimes(2);
    expect(repository.settleProviderCall).not.toHaveBeenCalled();
  });

  it('maps database failures to a denial before provider transmission', async () => {
    const repository = ledger();
    repository.reserveProviderCall.mockRejectedValueOnce(new Error('private database detail'));
    const service = new ProviderCallCreditAdmission(repository);
    await expect(service.reserveBeforeSend(request)).rejects.toMatchObject({
      reason: 'ledger_unavailable'
    } satisfies Partial<ProviderCreditAdmissionDeniedError>);
  });
});
