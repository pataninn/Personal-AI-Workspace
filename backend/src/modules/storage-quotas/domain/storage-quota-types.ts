export type StorageAccountingState = 'reconciling' | 'ready' | 'unavailable';

export type StorageResourceKind = 'database_content' | 'project_file' | 'recovery_file' | 'retained_root';

export interface StorageUsageSnapshot {
  readonly state: StorageAccountingState;
  readonly usedBytes: bigint | null;
  readonly reservedBytes: bigint | null;
  readonly limitBytes: bigint | null;
  readonly availableBytes: bigint | null;
  readonly overLimit: boolean | null;
  readonly asOf: Date | null;
}

export interface StorageResourceReference {
  readonly ownerId: string;
  readonly kind: StorageResourceKind;
  readonly resourceKey: string;
  readonly copyKey: string;
  readonly bytes: bigint;
  readonly projectId: string | null;
  readonly rootKey: string | null;
  readonly relativeKey: string | null;
  readonly sha256: string | null;
}

export interface StorageResourceReferenceChange {
  readonly reference: StorageResourceReference;
  /** Null removes this exact persisted copy. */
  readonly nextBytes: bigint | null;
  readonly nextSha256: string | null;
}

export interface StorageFileReferencePlan {
  readonly kind: 'project_file' | 'recovery_file' | 'retained_root';
  readonly resourceKey: string;
  readonly copyKey: string;
  readonly projectId: string | null;
  readonly rootKey: string;
  /** Relative to the trusted root; never an absolute path. */
  readonly relativeKey: string;
  readonly expectedPriorBytes: bigint | null;
  readonly expectedPriorSha256: string | null;
  readonly intendedBytes: bigint | null;
  readonly intendedSha256: string | null;
}

export interface StorageFileOperationCommand {
  readonly ownerId: string;
  readonly operationKey: string;
  readonly fingerprint: string;
  readonly projectId: string | null;
  readonly rootKey: string;
  readonly targetKey: string;
  readonly changes: readonly StorageFileReferencePlan[];
}

/** Persisted root mapping copied from the database while the quota reservation is locked. */
export interface StorageTrustedProjectRoot {
  readonly ownerId: string;
  readonly projectId: string | null;
  /** Immutable original project UUID used only to reconstruct the trusted root after project deletion. */
  readonly locatorProjectId: string;
  readonly rootKey: string;
  readonly storageKind: 'legacy' | 'managed';
  readonly relativeRoot: string;
}

export interface StorageTrustedFileScope {
  readonly ownerId: string;
  readonly projectId: string | null;
  readonly roots: readonly StorageTrustedProjectRoot[];
}

export interface StorageVerifiedFileChange {
  readonly kind: StorageFileReferencePlan['kind'];
  readonly resourceKey: string;
  readonly copyKey: string;
  readonly projectId: string | null;
  readonly rootKey: string;
  readonly relativeKey: string;
  readonly bytes: bigint | null;
  readonly sha256: string | null;
}

export interface StorageFileOperationReservation {
  readonly operationId: string;
  readonly state: 'reserved' | 'unknown' | 'settled' | 'released';
  readonly outcome: readonly StorageVerifiedFileChange[] | null;
  readonly replay: boolean;
  /** Present only for a newly committed reservation; replay never enters filesystem code. */
  readonly trustedScope?: StorageTrustedFileScope;
}

export interface StorageUnresolvedFileOperation {
  readonly operationId: string;
  readonly state: 'pending' | 'unknown';
  readonly reservedGrowthBytes: bigint;
  readonly command: StorageFileOperationCommand;
}
