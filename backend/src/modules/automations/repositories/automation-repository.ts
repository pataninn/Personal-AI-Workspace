import type { AutomationLeaseFence, AutomationOccurrence, AutomationOccurrenceStatus, AutomationSchedule, AutomationTaskSourceRevision } from '@/modules/automations/domain/automation-types';

export interface CreateAutomationScheduleRecord {
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly skillId: string;
  readonly skillVersion: number;
  readonly skillRevisionId: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly nextDueAt: Date;
  readonly createKeyDigest: string;
  readonly requestFingerprint: string;
}

export interface UpdateAutomationScheduleRecord {
  readonly ownerId: string;
  readonly scheduleId: string;
  readonly expectedRevision: number;
  readonly skillId: string;
  readonly skillVersion: number;
  readonly skillRevisionId: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly enabled: boolean;
  readonly nextDueAt: Date | null;
}

export interface AutomationTurnReference {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly occurrenceId: string;
}

export type AutomationCancellationOutcome = 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'interrupted_unknown';

export interface HomeAutomationFence {
  readonly occurrenceId: string;
  readonly leaseToken: string;
  readonly generation: number;
}

export interface UpdateAutomationScheduleResult {
  readonly schedule: AutomationSchedule;
  readonly activeTurns: readonly AutomationTurnReference[];
}

export interface CreateAutomationOccurrenceRecord {
  readonly ownerId: string;
  readonly scheduleId: string;
  readonly expectedRevision: number;
  readonly requestKeyDigest: string;
  readonly requestFingerprint: string;
}

export interface ClaimedAutomationOccurrence {
  readonly occurrence: AutomationOccurrence;
  readonly fence: AutomationLeaseFence;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly skillId: string;
}

export interface AutomationOccurrencePage {
  readonly occurrences: readonly AutomationOccurrence[];
  readonly nextCursor: string | null;
}

export interface IAutomationRepository {
  createSchedule(input: CreateAutomationScheduleRecord): Promise<{ readonly schedule: AutomationSchedule; readonly replayed: boolean }>;
  findCreatedSchedule(ownerId: string, createKeyDigest: string, requestFingerprint: string): Promise<AutomationSchedule | null>;
  listSchedules(ownerId: string): Promise<readonly AutomationSchedule[]>;
  findSchedule(ownerId: string, scheduleId: string): Promise<AutomationSchedule | null>;
  updateSchedule(input: UpdateAutomationScheduleRecord): Promise<UpdateAutomationScheduleResult>;
  createManualOccurrence(input: CreateAutomationOccurrenceRecord): Promise<{ readonly occurrence: AutomationOccurrence; readonly replayed: boolean }>;
  listOccurrences(input: { readonly ownerId: string; readonly scheduleId: string; readonly limit: number; readonly before?: string }): Promise<AutomationOccurrencePage | null>;
  materializeDueSchedules(limit: number): Promise<number>;
  claimBatch(input: { readonly limit: number; readonly leaseMilliseconds: number }): Promise<readonly ClaimedAutomationOccurrence[]>;
  findOccurrence(ownerId: string, occurrenceId: string): Promise<AutomationOccurrence | null>;
  assertDispatchCurrent(input: AutomationLeaseFence): Promise<boolean>;
  beginDispatch(input: AutomationLeaseFence): Promise<boolean>;
  heartbeat(input: AutomationLeaseFence, leaseMilliseconds: number): Promise<boolean>;
  recordTurnStatus(input: AutomationLeaseFence & { readonly status: AutomationOccurrenceStatus; readonly failureCode?: string }): Promise<boolean>;
  releasePollingClaim(input: AutomationLeaseFence): Promise<boolean>;
  recordCancellationResult(input: { readonly occurrenceId: string; readonly status: AutomationCancellationOutcome }): Promise<boolean>;
  finishWithoutTurn(input: AutomationLeaseFence & { readonly status: 'failed' | 'skipped'; readonly failureCode: string }): Promise<boolean>;
  releaseSafeClaim(input: AutomationLeaseFence, failureCode: string): Promise<boolean>;
  recordTaskSources(input: { readonly ownerId: string; readonly fence: AutomationLeaseFence; readonly sources: readonly AutomationTaskSourceRevision[] }): Promise<'recorded' | 'limit_exceeded' | 'lease_lost'>;
}
