import { AutomationWorker } from '@/modules/automations/use-cases/automation-worker';
import type { ClaimedAutomationOccurrence, IAutomationRepository } from '@/modules/automations/repositories/automation-repository';
import type { ProcessHomeTurnUseCase } from '@/modules/home-assistant/use-cases/process-home-turn';
import type { CancelHomeTurnUseCase } from '@/modules/home-assistant/use-cases/cancel-home-turn';
import type { InvokeSkillUseCase } from '@/modules/skills/use-cases/invoke-skill';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222';
const OCCURRENCE_ID = '33333333-3333-4333-8333-333333333333';
const TURN_ID = '44444444-4444-4444-8444-444444444444';
const CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';
const SKILL_ID = '66666666-6666-4666-8666-666666666666';
const REVISION_ID = '77777777-7777-4777-8777-777777777777';

function claimed(homeTurnId: string | null, status: 'claimed' | 'running' | 'interrupted_unknown' = 'claimed'): ClaimedAutomationOccurrence {
  return {
    occurrence: {
      id: OCCURRENCE_ID, ownerId: OWNER_ID, scheduleId: SCHEDULE_ID, kind: 'scheduled',
      intendedFor: new Date('2026-10-19T00:00:00Z'), localDate: '2026-10-19', status,
      scheduleRevision: 1, skillVersion: 1, skillRevisionId: REVISION_ID, homeTurnId,
      attemptCount: 1, failureCode: null, claimedUntil: new Date(Date.now() + 120_000),
      createdAt: new Date(), updatedAt: new Date()
    },
    fence: { occurrenceId: OCCURRENCE_ID, leaseToken: '88888888-8888-4888-8888-888888888888', generation: 1 },
    workspaceId: '99999999-9999-4999-8999-999999999999', conversationId: CONVERSATION_ID, skillId: SKILL_ID
  };
}

function setup(item: ClaimedAutomationOccurrence) {
  let current = { ...item.occurrence };
  const repository = {
    materializeDueSchedules: jest.fn(async () => 1),
    claimBatch: jest.fn(async () => [item]),
    findOccurrence: jest.fn(async () => current),
    assertDispatchCurrent: jest.fn(async () => true),
    beginDispatch: jest.fn(async () => true),
    heartbeat: jest.fn(async () => true),
    recordTurnStatus: jest.fn(async (input: { status: typeof current.status }) => { current = { ...current, status: input.status }; return true; }),
    finishWithoutTurn: jest.fn(async () => true),
    releaseSafeClaim: jest.fn(async () => true)
  } as unknown as IAutomationRepository & { recordTurnStatus: jest.Mock; beginDispatch: jest.Mock; finishWithoutTurn: jest.Mock; releaseSafeClaim: jest.Mock };
  const invokeSkill = { execute: jest.fn(async () => ({ invocation: { id: 'invoke-id', turnId: TURN_ID, state: 'running' } })) } as unknown as InvokeSkillUseCase & { execute: jest.Mock };
  const getHomeTurn = { execute: jest.fn(async () => ({ id: TURN_ID, status: 'completed' })) } as unknown as ProcessHomeTurnUseCase & { execute: jest.Mock };
  const cancelHomeTurn = { execute: jest.fn() } as unknown as CancelHomeTurnUseCase;
  return { worker: new AutomationWorker(repository, invokeSkill, getHomeTurn, cancelHomeTurn), repository, invokeSkill, getHomeTurn };
}

describe('AutomationWorker', () => {
  it('stops trusting the lease when a background heartbeat fails without rejecting the timer', async () => {
    jest.useFakeTimers();
    try {
      const { worker, repository, getHomeTurn } = setup(claimed(TURN_ID, 'running'));
      (repository.heartbeat as jest.Mock).mockRejectedValue(new Error('database temporarily unavailable'));
      let releasePoll: (() => void) | undefined;
      getHomeTurn.execute.mockImplementation(async (input: { automationGuard: { isCurrent(): Promise<boolean> } }) => {
        await new Promise<void>((resolve) => { releasePoll = resolve; });
        expect(await input.automationGuard.isCurrent()).toBe(false);
        return { status: 'unknown' };
      });
      const pass = worker.runOnce();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(repository.heartbeat).toHaveBeenCalledTimes(1);
      releasePoll?.();
      await pass;
      expect(repository.recordTurnStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'interrupted_unknown' }));
    } finally { jest.useRealTimers(); }
  });

  it('dispatches a new occurrence through the skill use case and records its existing Home turn result', async () => {
    const { worker, repository, invokeSkill, getHomeTurn } = setup(claimed(null));
    (repository.findOccurrence as jest.Mock).mockResolvedValueOnce(claimed(null).occurrence).mockResolvedValueOnce({ ...claimed(null).occurrence, homeTurnId: TURN_ID, status: 'running' });

    await expect(worker.runOnce()).resolves.toBe(1);

    expect(repository.beginDispatch).toHaveBeenCalledTimes(1);
    expect(invokeSkill.execute).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: OWNER_ID, skillId: SKILL_ID, conversationId: CONVERSATION_ID, requestKey: `schedule-${OCCURRENCE_ID}`
    }));
    expect(getHomeTurn.execute).toHaveBeenCalledWith(expect.objectContaining({ turnId: TURN_ID, automationGuard: expect.any(Object) }));
    expect(repository.recordTurnStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }));
  });

  it('reconciles a persisted unknown turn after restart without invoking the skill again', async () => {
    const { worker, repository, invokeSkill, getHomeTurn } = setup(claimed(TURN_ID, 'interrupted_unknown'));

    await worker.runOnce();

    expect(invokeSkill.execute).not.toHaveBeenCalled();
    expect(getHomeTurn.execute).toHaveBeenCalledTimes(1);
    expect(repository.recordTurnStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }));
  });

  it('fails closed before dispatch when the occurrence fence is stale', async () => {
    const { worker, repository, invokeSkill } = setup(claimed(null));
    (repository.assertDispatchCurrent as jest.Mock).mockResolvedValue(false);

    await worker.runOnce();

    expect(invokeSkill.execute).not.toHaveBeenCalled();
    expect(repository.finishWithoutTurn).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped', failureCode: 'SCHEDULE_NO_LONGER_CURRENT' }));
  });
});
