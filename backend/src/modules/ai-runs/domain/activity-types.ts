import type { AiRun } from '@/modules/ai-runs/domain/ai-run-types';
import type { ChangeSetStatus } from '@/modules/ai-runs/domain/change-types';

export const AI_RUN_ACTIVITY_FILTERS = ['all', 'active', 'succeeded', 'attention', 'cancelled', 'rejected'] as const;
export type AiRunActivityFilter = typeof AI_RUN_ACTIVITY_FILTERS[number];

export interface AiRunActivityChangeSummary {
  readonly status: ChangeSetStatus;
  readonly operationCount: number;
  readonly appliedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly backupCount: number;
}

export interface AiRunActivityRecord {
  readonly run: AiRun;
  readonly changeSet: AiRunActivityChangeSummary | null;
}

export interface ListAiRunActivityInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly filter: AiRunActivityFilter;
  readonly limit: number;
  readonly cursor?: { readonly createdAt: Date; readonly id: string };
}

export interface AiRunActivityRecordPage {
  readonly records: readonly AiRunActivityRecord[];
  readonly hasMore: boolean;
}

export type AiRunActivityUsageStatus = 'reported' | 'partial' | 'not_reported' | 'not_transmitted' | 'unknown' | 'unavailable';

export interface AiRunActivityUsage {
  readonly status: AiRunActivityUsageStatus;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface AiRunActivityCost {
  readonly status: 'unavailable';
  readonly label: 'Unavailable — no rate configured';
}

export interface AiRunActivityContextSummary {
  readonly categories: readonly string[];
  readonly fileCount: number;
  readonly factCount: number;
  readonly messageCount: number;
  readonly estimatedTokens: number;
}

export interface AiRunActivityItem {
  readonly runId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly status: AiRun['status'];
  readonly decision: AiRun['decision'];
  readonly providerTransmission: AiRun['providerTransmission'];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly provider: string;
  readonly model: string;
  readonly requestPreview: string;
  readonly context: AiRunActivityContextSummary;
  readonly usage: AiRunActivityUsage;
  readonly cost: AiRunActivityCost;
  readonly changeSet: AiRunActivityChangeSummary | null;
}

export interface AiRunActivityOperation {
  readonly operation: string;
  readonly path: string;
  readonly outcome: string;
  readonly backupStatus: string;
}

export interface AiRunActivityDetail extends AiRunActivityItem {
  readonly assistantPreview: string | null;
  readonly selectedFiles: readonly string[];
  readonly selectedFactTitles: readonly string[];
  readonly operations: readonly AiRunActivityOperation[];
  readonly omittedOperationCount: number;
}
