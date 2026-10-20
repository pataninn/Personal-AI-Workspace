import type { HomeAutomationFence } from '@/modules/home-assistant/repositories/home-conversation-repository';

export type HomeTaskSourceWriteResult = 'recorded' | 'limit_exceeded' | 'lease_lost';

/** Persists scoped task-read revisions under the active automation lease. */
export interface IHomeAutomationSourceRecorder {
  recordTaskSources(input: {
    readonly ownerId: string;
    readonly fence: HomeAutomationFence;
    readonly sources: readonly { readonly taskId: string; readonly revision: number }[];
  }): Promise<HomeTaskSourceWriteResult>;
  markBudgetSkipped(input: { readonly ownerId: string; readonly fence: HomeAutomationFence }): Promise<boolean>;
}
