export type ChangeOperationKind = 'create' | 'edit' | 'overwrite' | 'rename' | 'delete';

export type ChangeSetStatus =
  | 'awaiting_approval'
  | 'applying'
  | 'applied'
  | 'rejected'
  | 'stale'
  | 'blocked'
  | 'failed'
  | 'needs_manual_review';

export type ChangeSetDecision = 'pending' | 'approved' | 'rejected';

export type ChangeOperationResultStatus = 'applied' | 'skipped' | 'failed' | 'needs_manual_review';
export type ChangeBackupStatus = 'not_required' | 'created' | 'failed' | 'unknown';

export interface ChangeSetCounts {
  readonly total: number;
  readonly creates: number;
  readonly edits: number;
  readonly overwrites: number;
  readonly renames: number;
  readonly deletes: number;
  readonly destructive: number;
}

export interface BackupCheckpoint {
  /** Opaque server-only recovery reference; never serialize this to the browser. */
  readonly reference: string;
  readonly operationId: string;
  readonly path: string;
  readonly destinationPath?: string;
  readonly sizeBytes: number;
  readonly contentSha256: string;
  readonly createdAt: Date;
}

export interface RuntimeChangeProposal {
  readonly operation: ChangeOperationKind;
  readonly path: string;
  readonly destinationPath?: string;
  readonly content?: string;
  readonly expectedSourceHash?: string;
  readonly expectedDestinationHash?: string;
  readonly summary?: string;
}

export interface ChangePreview {
  readonly text: string;
  readonly limited: boolean;
  readonly kind: 'before' | 'after' | 'diff';
}

export interface ProposedChangeOperation {
  readonly operationId: string;
  readonly operation: ChangeOperationKind;
  readonly path: string;
  readonly destinationPath?: string;
  readonly content?: string;
  readonly summary: string;
  readonly expectedSourceHash?: string;
  readonly expectedDestinationHash?: string;
  readonly sourcePresent: boolean;
  readonly destinationPresent: boolean;
  readonly backupRequired: boolean;
  readonly preview?: ChangePreview;
  readonly sizeBytes: number;
  readonly lineCount: number;
  readonly reviewable: boolean;
}

export interface ChangeOperationResult {
  readonly operationId: string;
  readonly operation: ChangeOperationKind;
  readonly path: string;
  readonly destinationPath?: string;
  readonly status: ChangeOperationResultStatus;
  readonly backup: ChangeBackupStatus;
  /** Internal recovery reference. It is intentionally excluded from public DTOs. */
  readonly backupReference?: string;
  readonly safeMessage: string;
}

export interface ChangeSetResult {
  readonly persisted: true;
  readonly operations: readonly ChangeOperationResult[];
  readonly appliedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly backupCount: number;
}

export interface ProposedChangeSet {
  readonly id: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly proposalHash: string;
  readonly status: ChangeSetStatus;
  readonly decision: ChangeSetDecision;
  readonly operations: readonly ProposedChangeOperation[];
  readonly counts: ChangeSetCounts;
  readonly totalSizeBytes: number;
  readonly totalLineCount: number;
  readonly previewLimitBytes: number;
  readonly previewLimitLines: number;
  readonly fakeRuntime: boolean;
  readonly backupCheckpoints?: readonly BackupCheckpoint[];
  readonly result?: ChangeSetResult;
  readonly decisionIdempotencyKey?: string;
  readonly decisionFingerprint?: string;
  readonly safeMessage: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateProposedChangeSetRecord {
  readonly runId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly proposalHash: string;
  readonly operations: readonly ProposedChangeOperation[];
  readonly counts: ChangeSetCounts;
  readonly totalSizeBytes: number;
  readonly totalLineCount: number;
  readonly previewLimitBytes: number;
  readonly previewLimitLines: number;
  readonly fakeRuntime: boolean;
}

export interface ChangeSetDecisionUpdate {
  readonly ownerId: string;
  readonly runId: string;
  readonly proposalHash: string;
  readonly decision: 'approve' | 'reject';
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface ChangeSetDecisionResult {
  readonly resource: ProposedChangeSet;
  readonly replayed: boolean;
}
