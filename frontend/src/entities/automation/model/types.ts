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
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly skillId: string;
  readonly skillVersion: number;
  readonly localTime: string;
  readonly timeZone: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly nextDueAt: string | null;
  readonly lastRunStatus: AutomationOccurrenceStatus | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationTaskSource {
  readonly taskId: string;
  readonly revision: number;
  readonly available: boolean;
  readonly title: string | null;
  readonly href: string | null;
}

export interface AutomationProviderCall {
  readonly status: 'pending' | 'unknown' | 'settled' | 'over_bound';
  readonly providerProfile: string;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly chargedUnits: string | null;
}

export interface AutomationProviderUsage {
  readonly state: 'not_started' | 'settled' | 'pending' | 'unknown';
  readonly calls: readonly AutomationProviderCall[];
}

export interface AutomationOccurrence {
  readonly id: string;
  readonly kind: AutomationOccurrenceKind;
  readonly intendedFor: string;
  readonly status: AutomationOccurrenceStatus;
  readonly scheduleRevision: number;
  readonly skillVersion: number;
  readonly homeTurnId: string | null;
  readonly failureCode: string | null;
  readonly attemptCount: number;
  readonly taskSources: readonly AutomationTaskSource[];
  readonly providerUsage: AutomationProviderUsage;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationOccurrencePage {
  readonly occurrences: readonly AutomationOccurrence[];
  readonly nextCursor: string | null;
}

export interface CreateAutomationScheduleRequest {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly skillVersion: number;
  readonly localTime: string;
  readonly timeZone: string;
}

export interface UpdateAutomationScheduleRequest {
  readonly expectedRevision: number;
  readonly skillId?: string;
  readonly skillVersion?: number;
  readonly localTime?: string;
  readonly timeZone?: string;
  readonly enabled?: boolean;
}
