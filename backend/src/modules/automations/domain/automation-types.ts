import type { HomeTurnStatus } from '@/modules/home-assistant/domain/home-conversation-types';

export type AutomationOccurrenceKind = 'scheduled' | 'manual';
export type AutomationOccurrenceStatus =
  | 'queued'
  | 'claimed'
  | 'dispatching'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted_unknown'
  | 'skipped';

export interface AutomationSchedule {
  readonly id: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly skillId: string;
  readonly skillRevisionId: string;
  readonly skillVersion: number;
  readonly localTime: string;
  readonly timeZone: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly nextDueAt: Date | null;
  readonly lastRunStatus: AutomationOccurrenceStatus | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AutomationOccurrence {
  readonly id: string;
  readonly ownerId: string;
  readonly scheduleId: string;
  readonly kind: AutomationOccurrenceKind;
  readonly intendedFor: Date;
  readonly localDate: string;
  readonly status: AutomationOccurrenceStatus;
  readonly scheduleRevision: number;
  readonly skillVersion: number;
  readonly skillRevisionId: string | null;
  readonly homeTurnId: string | null;
  readonly attemptCount: number;
  readonly failureCode: string | null;
  readonly claimedUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AutomationLeaseFence {
  readonly occurrenceId: string;
  readonly leaseToken: string;
  readonly generation: number;
}

export interface ScheduledHomeTurnResult {
  readonly turnId: string;
  readonly status: HomeTurnStatus;
  readonly skillInvocationId: string;
  readonly skillRevisionId: string;
  readonly skillVersion: number;
}
