import type { StorageFileOperationScopeRequest } from '@/modules/storage-quotas/repositories/storage-quota-repository';
import type { StorageTrustedFileScope } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { StorageQuotaTransaction } from '@/modules/storage-quotas/repositories/storage-quota-repository';

export type StorageRootMappingState = 'active' | 'retained';

/** Persisted trusted locator; it contains no absolute host path. */
export interface StorageRootMapping {
  readonly ownerId: string;
  readonly projectId: string | null;
  readonly locatorProjectId: string;
  readonly rootKey: string;
  readonly storageKind: 'legacy' | 'managed';
  readonly relativeRoot: string;
  readonly state: StorageRootMappingState;
}

export interface RetainProjectStorageRootInput {
  readonly ownerId: string;
  readonly projectId: string;
}

export interface DeleteVerifiedRetainedStorageRootInput {
  readonly ownerId: string;
  readonly rootKey: string;
}

export interface RegisterVerifiedRetainedManagedOrphanInput {
  readonly ownerId: string;
  readonly locatorProjectId: string;
}

/** Database-only owner/root mapping operations used by quota reservations and reconciliation. */
export interface IStorageRootMappingRepository {
  resolveTrustedScope(
    transaction: StorageQuotaTransaction,
    request: StorageFileOperationScopeRequest
  ): Promise<StorageTrustedFileScope>;
  listMappings(ownerId?: string): Promise<readonly StorageRootMapping[]>;
  registerVerifiedRetainedManagedOrphan(
    input: RegisterVerifiedRetainedManagedOrphanInput
  ): Promise<StorageRootMapping>;
  retainProjectRoot(
    transaction: StorageQuotaTransaction,
    input: RetainProjectStorageRootInput
  ): Promise<StorageRootMapping>;
  deleteVerifiedRetained(
    transaction: StorageQuotaTransaction,
    input: DeleteVerifiedRetainedStorageRootInput
  ): Promise<void>;
}
