import {
  operationConflict,
  reconciliationPending,
  StorageQuotaError
} from '@/modules/storage-quotas/domain/storage-quota-errors';
import type {
  StorageFileOperationCommand,
  StorageFileOperationReservation,
  StorageTrustedFileScope,
  StorageVerifiedFileChange
} from '@/modules/storage-quotas/domain/storage-quota-types';
import type { IStorageQuotaRepository, StorageTrustedFileScopeResolver } from '@/modules/storage-quotas/repositories/storage-quota-repository';

export interface VerifiedFileMutation<T> {
  readonly result: T;
  /** Populated only after trusted filesystem verification of every planned effect. */
  readonly changes: readonly StorageVerifiedFileChange[];
}

export type StorageFileMutationResult<T> =
  | { readonly state: 'applied'; readonly operationId: string; readonly result: T; readonly replay: false }
  | { readonly state: 'settled'; readonly operationId: string; readonly changes: readonly StorageVerifiedFileChange[]; readonly replay: true };

/** Marks a failure that the caller has proved happened before any authoritative filesystem side effect. */
export class StorageQuotaNoSideEffectError extends Error {
  public constructor(public readonly originalError?: unknown, message = 'The file operation failed before changing authoritative storage.') {
    super(message);
    this.name = 'StorageQuotaNoSideEffectError';
  }
}

/** A failed filesystem action whose complete on-disk result was measured at its planned locations. */
export class StorageQuotaKnownOutcomeError extends Error {
  public constructor(
    public readonly originalError: unknown,
    public readonly changes: readonly StorageVerifiedFileChange[]
  ) {
    super('The file operation failed after reaching a verified filesystem state.');
    this.name = 'StorageQuotaKnownOutcomeError';
  }
}

/** Persists reservation before invoking filesystem code and settles only verified results. */
export class StorageQuotaFileMutation {
  public constructor(private readonly storage: IStorageQuotaRepository) {}

  public async execute<T>(
    command: StorageFileOperationCommand,
    resolveTrustedScope: StorageTrustedFileScopeResolver,
    apply: (trustedScope: StorageTrustedFileScope) => Promise<VerifiedFileMutation<T>>
  ): Promise<StorageFileMutationResult<T>> {
    const reservation = await this.storage.reserveFileOperation(command, resolveTrustedScope);
    if (reservation.state === 'settled') {
      if (!reservation.outcome) throw reconciliationPending(reservation.operationId);
      return { state: 'settled', operationId: reservation.operationId, changes: reservation.outcome, replay: true };
    }
    if (reservation.state === 'released') throw operationConflict();
    if (reservation.state === 'unknown' || reservation.replay) throw reconciliationPending(reservation.operationId);
    if (!reservation.trustedScope) {
      await this.storage.markFileOperationUnknown(command.ownerId, reservation.operationId).catch(() => undefined);
      throw reconciliationPending(reservation.operationId);
    }

    let applied: VerifiedFileMutation<T>;
    try {
      applied = await apply(reservation.trustedScope);
    } catch (error: unknown) {
      if (error instanceof StorageQuotaNoSideEffectError) {
        try {
          await this.storage.releaseFileOperationWithNoSideEffect(command.ownerId, reservation.operationId);
        } catch {
          await this.storage.markFileOperationUnknown(command.ownerId, reservation.operationId).catch(() => undefined);
          throw reconciliationPending(reservation.operationId);
        }
        if (error.originalError !== undefined) throw error.originalError;
        throw error;
      }
      if (error instanceof StorageQuotaKnownOutcomeError) {
        try {
          const settled = await this.storage.settleFileOperation(command.ownerId, reservation.operationId, error.changes);
          if (settled.state !== 'settled') throw reconciliationPending(reservation.operationId);
        } catch (settlementError: unknown) {
          await this.storage.markFileOperationUnknown(command.ownerId, reservation.operationId, error.changes).catch(() => undefined);
          if (settlementError instanceof StorageQuotaError && settlementError.code === 'STORAGE_RECONCILIATION_PENDING') throw settlementError;
          throw reconciliationPending(reservation.operationId);
        }
        if (error.originalError !== undefined) throw error.originalError;
        throw error;
      }
      await this.storage.markFileOperationUnknown(command.ownerId, reservation.operationId).catch(() => undefined);
      throw reconciliationPending(reservation.operationId);
    }

    try {
      const settled = await this.storage.settleFileOperation(command.ownerId, reservation.operationId, applied.changes);
      if (settled.state !== 'settled') throw reconciliationPending(reservation.operationId);
    } catch (error: unknown) {
      await this.storage.markFileOperationUnknown(command.ownerId, reservation.operationId, applied.changes).catch(() => undefined);
      if (error instanceof StorageQuotaError && error.code === 'STORAGE_RECONCILIATION_PENDING') throw error;
      throw reconciliationPending(reservation.operationId);
    }
    return { state: 'applied', operationId: reservation.operationId, result: applied.result, replay: false };
  }
}

export function isStorageFileOperationPending(reservation: StorageFileOperationReservation): boolean {
  return reservation.state === 'reserved' || reservation.state === 'unknown';
}
