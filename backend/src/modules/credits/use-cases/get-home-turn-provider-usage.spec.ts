import type { ICreditLedgerRepository } from '@/modules/credits/repositories/credit-ledger-repository';
import { GetHomeTurnProviderUsageUseCase } from '@/modules/credits/use-cases/get-home-turn-provider-usage';

function setup(rows: readonly unknown[]) {
  const ledger = { listHomeTurnProviderCallUsage: jest.fn(async () => rows) };
  return { useCase: new GetHomeTurnProviderUsageUseCase(ledger as unknown as Pick<ICreditLedgerRepository, 'listHomeTurnProviderCallUsage'>), ledger };
}

describe('GetHomeTurnProviderUsageUseCase', () => {
  it('projects model and usage from settled owner-scoped ledger receipts', async () => {
    const { useCase, ledger } = setup([{
      status: 'settled', providerProfile: 'provider-from-ledger', model: 'model-from-ledger',
      usage: { inputTokens: 1200, outputTokens: 180, chargedUnits: '4' }
    }]);

    await expect(useCase.getForHomeTurn('owner-1', 'turn-1')).resolves.toEqual({
      state: 'settled', calls: [{
        status: 'settled', providerProfile: 'provider-from-ledger', model: 'model-from-ledger',
        inputTokens: 1200, outputTokens: 180, chargedUnits: '4'
      }]
    });
    expect(ledger.listHomeTurnProviderCallUsage).toHaveBeenCalledWith('owner-1', 'turn-1');
  });

  it('keeps missing or unknown settlement usage unknown', async () => {
    const missing = setup([{ status: 'settled', providerProfile: 'p', model: 'm' }]);
    await expect(missing.useCase.getForHomeTurn('owner-1', 'turn-1')).resolves.toMatchObject({ state: 'unknown' });

    const uncertain = setup([{ status: 'unknown', providerProfile: 'p', model: 'm' }]);
    await expect(uncertain.useCase.getForHomeTurn('owner-1', 'turn-1')).resolves.toEqual({
      state: 'unknown', calls: [{ status: 'unknown', providerProfile: 'p', model: 'm', inputTokens: null, outputTokens: null, chargedUnits: null }]
    });
  });

  it('reports released-only calls as not started and in-flight reservations as pending', async () => {
    const released = setup([{ status: 'released', providerProfile: 'p', model: 'm' }]);
    await expect(released.useCase.getForHomeTurn('owner-1', 'turn-1')).resolves.toEqual({ state: 'not_started', calls: [] });

    const pending = setup([{ status: 'in_flight', providerProfile: 'p', model: 'm' }]);
    await expect(pending.useCase.getForHomeTurn('owner-1', 'turn-1')).resolves.toMatchObject({ state: 'pending' });
  });

  it('rejects ledger histories beyond the existing per-source attempt bound', async () => {
    const { useCase } = setup(Array.from({ length: 33 }, () => ({ status: 'unknown', providerProfile: 'p', model: 'm' })));
    await expect(useCase.getForHomeTurn('owner-1', 'turn-1')).rejects.toThrow('call bound');
  });
});
