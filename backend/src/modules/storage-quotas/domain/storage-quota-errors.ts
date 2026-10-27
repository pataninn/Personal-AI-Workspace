export interface StorageQuotaFailureDetails {
  readonly usedBytes?: string;
  readonly reservedBytes?: string;
  readonly limitBytes?: string;
  readonly requestedGrowthBytes?: string;
  readonly operationId?: string;
}

export type StorageQuotaErrorCode =
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'STORAGE_ACCOUNTING_UNAVAILABLE'
  | 'STORAGE_RECONCILIATION_PENDING'
  | 'STORAGE_OPERATION_CONFLICT'
  | 'STORAGE_FILE_STATE_CHANGED';

export class StorageQuotaError extends Error {
  public constructor(
    public readonly code: StorageQuotaErrorCode,
    message: string,
    public readonly statusCode: 409 | 413 | 503,
    public readonly details: StorageQuotaFailureDetails = {}
  ) {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

export function quotaExceeded(details: Required<Omit<StorageQuotaFailureDetails, 'operationId'>>): StorageQuotaError {
  return new StorageQuotaError(
    'STORAGE_QUOTA_EXCEEDED',
    'The storage quota does not allow this increase.',
    413,
    details
  );
}

export function accountingUnavailable(): StorageQuotaError {
  return new StorageQuotaError(
    'STORAGE_ACCOUNTING_UNAVAILABLE',
    'Storage accounting is not ready for this account.',
    503
  );
}

export function reconciliationPending(operationId: string): StorageQuotaError {
  return new StorageQuotaError(
    'STORAGE_RECONCILIATION_PENDING',
    'The file operation outcome is pending reconciliation.',
    503,
    { operationId }
  );
}

export function operationConflict(): StorageQuotaError {
  return new StorageQuotaError(
    'STORAGE_OPERATION_CONFLICT',
    'The operation key was already used for a different file mutation.',
    409
  );
}

export function fileStateChanged(): StorageQuotaError {
  return new StorageQuotaError(
    'STORAGE_FILE_STATE_CHANGED',
    'The stored file state changed before the operation could be applied.',
    409
  );
}
