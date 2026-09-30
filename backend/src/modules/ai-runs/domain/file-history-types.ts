import type { ChangeBackupStatus, ChangeOperationKind, ChangeOperationResultStatus, ChangeSetStatus } from '@/modules/ai-runs/domain/change-types';

export type ProjectFileHistoryOutcome = 'all' | 'applied';
export type ProjectFileHistoryBackupStatus = ChangeBackupStatus | 'pending' | 'not_created';

export interface ProjectFileHistoryCursor {
  readonly createdAt: Date;
  readonly changeSetId: string;
  readonly operationIndex: number;
}

export interface ListProjectFileHistoryInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly path: string;
  readonly outcome: ProjectFileHistoryOutcome;
  readonly limit: number;
  readonly cursor?: ProjectFileHistoryCursor;
}

export interface ProjectFileHistoryRecord {
  readonly changeSetId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly conversationId: string | null;
  readonly operationId: string;
  readonly operationIndex: number;
  readonly operation: ChangeOperationKind;
  readonly matchedPath: string;
  readonly path: string;
  readonly destinationPath?: string;
  readonly summary: string;
  readonly changeSetStatus: ChangeSetStatus;
  readonly operationStatus: ChangeOperationResultStatus | null;
  readonly backupStatus: ProjectFileHistoryBackupStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProjectFileHistoryRecordPage {
  readonly records: readonly ProjectFileHistoryRecord[];
  readonly hasMore: boolean;
}

export interface ProjectFileHistoryItemDto extends Omit<ProjectFileHistoryRecord, 'createdAt' | 'updatedAt'> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectFileHistoryPageDto {
  readonly projectId: string;
  readonly path: string;
  readonly outcome: ProjectFileHistoryOutcome;
  readonly items: readonly ProjectFileHistoryItemDto[];
  readonly nextCursor: string | null;
}
