import type { AutomationOccurrence } from '@/modules/automations/domain/automation-types';
import type { IAutomationRepository } from '@/modules/automations/repositories/automation-repository';
import type { IHomeTurnProviderUsageHistory } from '@/modules/credits/repositories/provider-call-usage-history';
import { ListAutomationOccurrencesUseCase } from '@/modules/automations/use-cases/automation-use-cases';

const ownerId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

function occurrence(overrides: Partial<AutomationOccurrence> = {}): AutomationOccurrence {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    ownerId,
    scheduleId: '44444444-4444-4444-8444-444444444444',
    kind: 'scheduled',
    intendedFor: new Date('2026-10-20T00:00:00.000Z'),
    localDate: '2026-10-20',
    status: 'skipped',
    scheduleRevision: 1,
    skillVersion: 1,
    skillRevisionId: null,
    homeTurnId: turnId,
    attemptCount: 1,
    failureCode: 'BUDGET_EXHAUSTED',
    claimedUntil: null,
    createdAt: new Date('2026-10-20T00:00:00.000Z'),
    updatedAt: new Date('2026-10-20T00:00:00.000Z'),
    ...overrides
  };
}

describe('ListAutomationOccurrencesUseCase', () => {
  it('projects a confirmed pre-send budget skip as not started when no provider call exists', async () => {
    const repository = { listOccurrences: jest.fn().mockResolvedValue({ occurrences: [occurrence()], nextCursor: null }) };
    const usage = { getForHomeTurn: jest.fn().mockResolvedValue({ state: 'unknown', calls: [] }) };
    const useCase = new ListAutomationOccurrencesUseCase(
      repository as unknown as IAutomationRepository,
      usage as unknown as IHomeTurnProviderUsageHistory
    );

    await expect(useCase.execute({ ownerId, scheduleId: occurrence().scheduleId, limit: 10 })).resolves.toMatchObject({
      occurrences: [{ providerUsage: { state: 'not_started', calls: [] } }]
    });
    expect(usage.getForHomeTurn).toHaveBeenCalledWith(ownerId, turnId);
  });

  it('preserves unknown usage whenever an admitted call has an uncertain receipt', async () => {
    const uncertainCall = {
      status: 'unknown' as const,
      providerProfile: 'configured-profile',
      model: 'configured-model',
      inputTokens: null,
      outputTokens: null,
      chargedUnits: null
    };
    const repository = { listOccurrences: jest.fn().mockResolvedValue({ occurrences: [occurrence()], nextCursor: null }) };
    const usage = { getForHomeTurn: jest.fn().mockResolvedValue({ state: 'unknown', calls: [uncertainCall] }) };
    const useCase = new ListAutomationOccurrencesUseCase(
      repository as unknown as IAutomationRepository,
      usage as unknown as IHomeTurnProviderUsageHistory
    );

    await expect(useCase.execute({ ownerId, scheduleId: occurrence().scheduleId, limit: 10 })).resolves.toMatchObject({
      occurrences: [{ providerUsage: { state: 'unknown', calls: [uncertainCall] } }]
    });
  });
});
