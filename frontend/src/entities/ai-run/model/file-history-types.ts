export type ProjectFileHistoryOutcome = 'all' | 'applied';

export interface ProjectFileHistoryItem {
  readonly changeSetId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly conversationId: string | null;
  readonly operationId: string;
  readonly operationIndex: number;
  readonly operation: 'create' | 'edit' | 'overwrite' | 'rename' | 'delete';
  readonly matchedPath: string;
  readonly path: string;
  readonly destinationPath?: string;
  readonly summary: string;
  readonly changeSetStatus: string;
  readonly operationStatus: 'applied' | 'skipped' | 'failed' | 'needs_manual_review' | null;
  readonly backupStatus: 'not_required' | 'created' | 'failed' | 'unknown' | 'pending' | 'not_created';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectFileHistoryPage {
  readonly projectId: string;
  readonly path: string;
  readonly outcome: ProjectFileHistoryOutcome;
  readonly items: readonly ProjectFileHistoryItem[];
  readonly nextCursor: string | null;
}
