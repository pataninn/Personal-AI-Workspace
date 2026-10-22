import type { AutomationLeaseFence, AutomationOccurrenceStatus } from '@/modules/automations/domain/automation-types';
import type { HomeTurnStatus } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IAutomationRepository, ClaimedAutomationOccurrence } from '@/modules/automations/repositories/automation-repository';
import type { GetHomeTurnUseCase } from '@/modules/home-assistant/use-cases/get-home-turn';
import type { CancelHomeTurnUseCase } from '@/modules/home-assistant/use-cases/cancel-home-turn';
import type { InvokeSkillUseCase } from '@/modules/skills/use-cases/invoke-skill';

const CLAIM_LIMIT = 8;
const LEASE_MILLISECONDS = 120_000;
const HEARTBEAT_MILLISECONDS = 30_000;
const SCHEDULED_REQUEST = 'Prepare the scheduled daily briefing for this workspace. Follow the selected skill and use only its permitted read capabilities.';

/** A bounded poll pass. PostgreSQL leases, not this process timer, arbitrate workers. */
export class AutomationWorker {
  public constructor(
    private readonly repository: IAutomationRepository,
    private readonly invokeSkill: InvokeSkillUseCase,
    private readonly getHomeTurn: GetHomeTurnUseCase,
    private readonly cancelHomeTurn: CancelHomeTurnUseCase
  ) {}

  public async runOnce(): Promise<number> {
    await this.repository.materializeDueSchedules(CLAIM_LIMIT);
    const claimed = await this.repository.claimBatch({ limit: CLAIM_LIMIT, leaseMilliseconds: LEASE_MILLISECONDS });
    for (const item of claimed) await this.process(item);
    return claimed.length;
  }

  private async process(item: ClaimedAutomationOccurrence): Promise<void> {
    let heartbeatRunning = true;
    const heartbeat = async (): Promise<boolean> => {
      if (!heartbeatRunning) return false;
      try { return await this.repository.heartbeat(item.fence, LEASE_MILLISECONDS); }
      catch { heartbeatRunning = false; return false; }
    };
    const timer = setInterval(() => { void heartbeat(); }, HEARTBEAT_MILLISECONDS);
    timer.unref?.();
    const guard = {
      fence: item.fence,
      isCurrent: async (): Promise<boolean> => heartbeatRunning && await this.repository.assertDispatchCurrent(item.fence),
      heartbeat
    };

    try {
      const occurrence = await this.repository.findOccurrence(item.occurrence.ownerId, item.occurrence.id);
      if (!occurrence || isTerminal(occurrence.status)) return;
      if (occurrence.homeTurnId) {
        await this.reconcileLinkedTurn(item, occurrence.status, occurrence.homeTurnId, guard);
        return;
      }
      if (occurrence.status === 'cancel_requested' || occurrence.status === 'interrupted_unknown') {
        await this.repository.finishWithoutTurn({ ...item.fence, status: 'skipped', failureCode: 'SCHEDULE_NO_LONGER_CURRENT' });
        return;
      }
      if (!await guard.isCurrent()) {
        await this.repository.finishWithoutTurn({ ...item.fence, status: 'skipped', failureCode: 'SCHEDULE_NO_LONGER_CURRENT' });
        return;
      }
      if (!await this.repository.beginDispatch(item.fence)) return;

      try {
        const result = await this.invokeSkill.execute({
          ownerId: occurrence.ownerId,
          skillId: item.skillId,
          conversationId: item.conversationId,
          expectedVersion: occurrence.skillVersion,
          requestKey: `schedule-${occurrence.id}`,
          request: SCHEDULED_REQUEST,
          automation: { fence: item.fence, isCurrent: guard.isCurrent, heartbeat }
        });
        if (!result.invocation.turnId && (result.invocation.state === 'denied' || result.invocation.state === 'unsupported')) {
          await this.repository.finishWithoutTurn({ ...item.fence, status: 'skipped', failureCode: 'SKILL_UNAVAILABLE' });
          return;
        }
      } catch {
        const after = await this.repository.findOccurrence(occurrence.ownerId, occurrence.id);
        if (after?.homeTurnId) {
          await this.repository.recordTurnStatus({ ...item.fence, status: 'interrupted_unknown', failureCode: 'HOME_RESULT_UNCERTAIN' });
        } else {
          await this.repository.releaseSafeClaim(item.fence, 'HOME_DISPATCH_NOT_CONFIRMED');
        }
        return;
      }

      const after = await this.repository.findOccurrence(occurrence.ownerId, occurrence.id);
      if (!after?.homeTurnId) {
        await this.repository.releaseSafeClaim(item.fence, 'HOME_TURN_NOT_LINKED');
        return;
      }
      await this.reconcileLinkedTurn(item, after.status, after.homeTurnId, guard);
    } finally {
      heartbeatRunning = false;
      clearInterval(timer);
    }
  }

  private async reconcileLinkedTurn(
    item: ClaimedAutomationOccurrence,
    status: AutomationOccurrenceStatus,
    turnId: string,
    guard: { readonly fence: AutomationLeaseFence; isCurrent(): Promise<boolean>; heartbeat(): Promise<boolean> }
  ): Promise<void> {
    if (status === 'cancel_requested' || !await guard.isCurrent()) {
      try {
        const cancelled = await this.cancelHomeTurn.execute({ ownerId: item.occurrence.ownerId, conversationId: item.conversationId, turnId });
        await this.repository.recordTurnStatus({
          ...item.fence,
          status: occurrenceStatus(cancelled.resource.status),
          ...(cancelled.resource.status === 'unknown' ? { failureCode: 'CANCELLATION_UNCONFIRMED' } : {})
        });
      } catch {
        await this.repository.recordTurnStatus({ ...item.fence, status: 'interrupted_unknown', failureCode: 'CANCELLATION_UNCONFIRMED' });
      }
      return;
    }

    try {
      const turn = await this.getHomeTurn.execute({
        ownerId: item.occurrence.ownerId,
        conversationId: item.conversationId,
        turnId,
        automationGuard: { fence: item.fence, isCurrent: guard.isCurrent }
      });
      await this.repository.recordTurnStatus({
        ...item.fence,
        status: occurrenceStatus(turn.status),
        ...(turn.status === 'unknown' ? { failureCode: 'HOME_RESULT_UNCERTAIN' } : {})
      });
    } catch {
      await this.repository.recordTurnStatus({ ...item.fence, status: 'interrupted_unknown', failureCode: 'HOME_RESULT_UNCERTAIN' });
    }
  }
}

function occurrenceStatus(status: HomeTurnStatus): AutomationOccurrenceStatus {
  switch (status) {
    case 'completed':
    case 'partial': return 'succeeded';
    case 'failed': return 'failed';
    case 'unsupported': return 'skipped';
    case 'cancelled': return 'cancelled';
    case 'unknown': return 'interrupted_unknown';
    case 'cancel_requested': return 'cancel_requested';
    case 'pending':
    case 'running': return 'running';
  }
}

function isTerminal(status: AutomationOccurrenceStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'skipped';
}
