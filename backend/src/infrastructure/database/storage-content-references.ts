import type { StorageResourceReferenceChange } from '@/modules/storage-quotas/domain/storage-quota-types';

const MAX_STORAGE_BYTES = 9_223_372_036_854_775_807n;

/** Builds the stable database-content copy reference used by transactional quota mutations. */
export function databaseContentChange(input: {
  readonly ownerId: string;
  readonly resourceTable: string;
  readonly resourceId: string;
  readonly copyKey: string;
  readonly nextBytes: bigint | number | string | null;
  readonly projectId?: string | null;
}): StorageResourceReferenceChange {
  const bytes = input.nextBytes === null ? null : BigInt(input.nextBytes);
  if (bytes !== null && (bytes < 0n || bytes > MAX_STORAGE_BYTES)) {
    throw new RangeError('Database content bytes must fit a nonnegative PostgreSQL BIGINT.');
  }
  const resourceKey = `${input.resourceTable}:${input.resourceId}`;
  if (resourceKey.length > 2048 || input.copyKey.length < 1 || input.copyKey.length > 2048) {
    throw new RangeError('The database content reference key is invalid.');
  }
  return {
    reference: {
      ownerId: input.ownerId,
      kind: 'database_content',
      resourceKey,
      copyKey: input.copyKey,
      bytes: bytes ?? 0n,
      projectId: input.projectId ?? null,
      rootKey: null,
      relativeKey: null,
      sha256: null
    },
    nextBytes: bytes,
    nextSha256: null
  };
}

/** Measures text exactly as PostgreSQL UTF-8 bytes; PostgreSQL text stores the same sequence. */
export function databaseTextBytes(value: string): bigint {
  return BigInt(Buffer.byteLength(value, 'utf8'));
}
