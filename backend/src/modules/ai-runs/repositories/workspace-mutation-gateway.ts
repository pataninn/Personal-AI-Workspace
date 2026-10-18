import type { BackupCheckpoint, ChangeBackupStatus, ChangeOperationKind, ProposedChangeOperation } from '@/modules/ai-runs/domain/change-types';

export interface WorkspaceMutationScope {
  readonly ownerId: string;
  readonly projectId: string;
  readonly storageKind: 'legacy' | 'managed';
  readonly relativeRoot: string;
}

export interface WorkspaceFileSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
  readonly content?: string;
  readonly hash?: string;
}

export interface WorkspaceApplyResult {
  readonly outcome: 'applied' | 'stale' | 'failed' | 'needs_manual_review';
  readonly conflict?: { readonly path: string; readonly reason: string };
  readonly operations: readonly {
    readonly operationId: string;
    readonly operation: ChangeOperationKind;
    readonly path: string;
    readonly destinationPath?: string;
    readonly status: 'applied' | 'skipped' | 'failed' | 'needs_manual_review';
    readonly backup: ChangeBackupStatus;
    /** Internal recovery reference. The REST serializer must omit it. */
    readonly backupReference?: string;
    readonly safeMessage: string;
  }[];
}

export interface WorkspaceMutationApplyOptions {
  /** Recheck current principal state before each externally visible filesystem promotion. */
  readonly assertPrincipalActive?: () => Promise<void>;
  /** Holds the principal row lock only while filesystem writes or promotions are in progress. */
  readonly withActivePrincipal?: <T>(action: (assertStillActive: () => Promise<void>) => Promise<T>) => Promise<T>;
  /** Called after a verified recovery snapshot and before destructive I/O. */
  readonly recordBackupCheckpoint?: (checkpoint: BackupCheckpoint) => Promise<void>;
}

export interface IWorkspaceMutationGateway {
  inspect(scope: WorkspaceMutationScope, relativePath: string): Promise<WorkspaceFileSnapshot>;
  applyChangeSet(scope: WorkspaceMutationScope, operations: readonly ProposedChangeOperation[], runId: string, proposalHash: string, options?: WorkspaceMutationApplyOptions): Promise<WorkspaceApplyResult>;
}
