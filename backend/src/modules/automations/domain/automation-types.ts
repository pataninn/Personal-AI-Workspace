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
  readonly taskSourceRevisions?: readonly AutomationTaskSourceRevision[];
  readonly taskSources?: readonly AutomationTaskSourceProjection[];
  readonly providerUsage?: AutomationProviderUsageProjection;
}

export interface AutomationTaskSourceRevision {
  readonly taskId: string;
  readonly revision: number;
}

export interface AutomationTaskSourceProjection extends AutomationTaskSourceRevision {
  readonly available: boolean;
  readonly title: string | null;
  readonly href: string | null;
}

export interface AutomationProviderUsageProjection {
  readonly state: 'not_started' | 'settled' | 'pending' | 'unknown';
  readonly calls: readonly {
    readonly status: 'pending' | 'unknown' | 'settled' | 'over_bound';
    readonly providerProfile: string;
    readonly model: string;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly chargedUnits: string | null;
    readonly estimated?: true;
  }[];
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
