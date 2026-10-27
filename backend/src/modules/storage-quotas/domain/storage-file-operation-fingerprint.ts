import { createHash } from 'node:crypto';

import type { StorageFileOperationCommand, StorageFileReferencePlan } from '@/modules/storage-quotas/domain/storage-quota-types';

type FingerprintInput = Omit<StorageFileOperationCommand, 'fingerprint'>;

/** Stable key derived from the full planned effect; replaying a key with changed bytes conflicts. */
export function storageFileOperationFingerprint(command: FingerprintInput): string {
  const changes = [...command.changes]
    .sort((left, right) => compare(referenceIdentity(left), referenceIdentity(right)))
    .map(stableChange);
  const canonical = JSON.stringify({
    ownerId: command.ownerId,
    operationKey: command.operationKey,
    projectId: command.projectId,
    rootKey: command.rootKey,
    targetKey: command.targetKey,
    changes
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function stableChange(change: StorageFileReferencePlan): Record<string, string | null> {
  return {
    kind: change.kind,
    resourceKey: change.resourceKey,
    copyKey: change.copyKey,
    projectId: change.projectId,
    rootKey: change.rootKey,
    relativeKey: change.relativeKey,
    expectedPriorBytes: change.expectedPriorBytes?.toString() ?? null,
    expectedPriorSha256: change.expectedPriorSha256,
    intendedBytes: change.intendedBytes?.toString() ?? null,
    intendedSha256: change.intendedSha256
  };
}

function referenceIdentity(change: StorageFileReferencePlan): string {
  return `${change.kind}\u0000${change.resourceKey}\u0000${change.copyKey}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
