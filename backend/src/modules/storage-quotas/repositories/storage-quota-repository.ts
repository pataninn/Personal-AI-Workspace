import type {
  StorageFileOperationCommand,
  StorageFileOperationReservation,
  StorageResourceReference,
  StorageResourceReferenceChange,
  StorageTrustedFileScope,
  StorageUnresolvedFileOperation,
  StorageUsageSnapshot,
  StorageVerifiedFileChange
} from '@/modules/storage-quotas/domain/storage-quota-types';

export interface StorageQuotaTransaction {
  query(query: string, parameters?: unknown[]): Promise<unknown>;
}

export interface StorageFileOperationScopeRequest {
  readonly ownerId: string;
  readonly projectId: string | null;
  readonly rootKeys: readonly string[];
}

/** Resolves database-backed project roots inside the reservation transaction, after quota locks. */
export type StorageTrustedFileScopeResolver = (
  transaction: StorageQuotaTransaction,
  request: StorageFileOperationScopeRequest
) => Promise<StorageTrustedFileScope>;

export interface StorageDatabaseMutationResult<T> {
  readonly result: T;
  readonly references: readonly StorageResourceReferenceChange[];
}

export interface IStorageQuotaRepository {
  readUsage(ownerId: string): Promise<StorageUsageSnapshot>;
  runDatabaseMutation<T>(
    transaction: StorageQuotaTransaction,
    input: { readonly ownerId: string; readonly maximumGrowthBytes: bigint },
    mutate: () => Promise<StorageDatabaseMutationResult<T>>,
    options?: { readonly beforeReferences?: () => Promise<void> }
  ): Promise<T>;
  reserveFileOperation(
    command: StorageFileOperationCommand,
    resolveTrustedScope: StorageTrustedFileScopeResolver
  ): Promise<StorageFileOperationReservation>;
  listUnresolvedFileOperations(ownerId: string): Promise<readonly StorageUnresolvedFileOperation[]>;
  settleFileOperation(ownerId: string, operationId: string, actualChanges: readonly StorageVerifiedFileChange[]): Promise<StorageFileOperationReservation>;
  releaseFileOperationWithNoSideEffect(ownerId: string, operationId: string): Promise<void>;
  markFileOperationUnknown(ownerId: string, operationId: string, observedChanges?: readonly StorageVerifiedFileChange[]): Promise<void>;
  reconcileReferences(ownerId: string, references: readonly StorageResourceReference[]): Promise<void>;
  markAccountUnavailable(ownerId: string): Promise<void>;
}
