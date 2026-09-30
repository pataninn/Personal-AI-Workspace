import type { AiRunStatus } from '@/entities/ai-run/model/types';

export type AiRunActivityFilter = 'all' | 'active' | 'succeeded' | 'attention' | 'cancelled' | 'rejected';
export type AiRunActivityUsageStatus = 'reported' | 'partial' | 'not_reported' | 'not_transmitted' | 'unknown' | 'unavailable';

export interface AiRunActivityUsage {
  readonly status: AiRunActivityUsageStatus;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface AiRunActivityChangeSummary {
  readonly status: string;
  readonly operationCount: number;
  readonly appliedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly backupCount: number;
}

export interface AiRunActivityItem {
  readonly runId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly status: AiRunStatus;
  readonly decision: 'pending' | 'approved' | 'rejected';
  readonly providerTransmission: 'not_started' | 'not_started_confirmed' | 'transmitted_confirmed' | 'unknown';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly provider: string;
  readonly model: string;
  readonly requestPreview: string;
  readonly context: {
    readonly categories: readonly string[];
    readonly fileCount: number;
    readonly factCount: number;
    readonly messageCount: number;
    readonly estimatedTokens: number;
  };
  readonly usage: AiRunActivityUsage;
  readonly cost: { readonly status: 'unavailable'; readonly label: string };
  readonly changeSet: AiRunActivityChangeSummary | null;
}

export interface AiRunActivityDetail extends AiRunActivityItem {
  readonly assistantPreview: string | null;
  readonly selectedFiles: readonly string[];
  readonly selectedFactTitles: readonly string[];
  readonly operations: readonly { readonly operation: string; readonly path: string; readonly destinationPath?: string; readonly outcome: string; readonly backupStatus: string }[];
  readonly omittedOperationCount: number;
}

export interface AiRunActivityPage {
  readonly projectId: string;
  readonly items: readonly AiRunActivityItem[];
  readonly nextCursor: string | null;
}
