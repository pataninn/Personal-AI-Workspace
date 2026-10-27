import { accountingUnavailable, quotaExceeded } from '@/modules/storage-quotas/domain/storage-quota-errors';
import type { StorageAccountingState } from '@/modules/storage-quotas/domain/storage-quota-types';

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export function assertByteCount(value: bigint, label = 'byte count'): void {
  if (value < 0n || value > POSTGRES_BIGINT_MAX) throw new RangeError(`${label} must fit a nonnegative PostgreSQL BIGINT.`);
}

export function assertStorageAdmission(input: {
  readonly state: StorageAccountingState;
  readonly usedBytes: bigint;
  readonly reservedBytes: bigint;
  readonly limitBytes: bigint | null;
  readonly requestedGrowthBytes: bigint;
}): void {
  assertByteCount(input.usedBytes, 'used bytes');
  assertByteCount(input.reservedBytes, 'reserved bytes');
  assertByteCount(input.requestedGrowthBytes, 'requested growth bytes');
  if (input.limitBytes !== null) assertByteCount(input.limitBytes, 'storage limit');
  if (input.requestedGrowthBytes === 0n) return;
  if (input.state !== 'ready') throw accountingUnavailable();

  const resultingBytes = input.usedBytes + input.reservedBytes + input.requestedGrowthBytes;
  if (resultingBytes > POSTGRES_BIGINT_MAX) throw accountingUnavailable();
  if (input.limitBytes !== null && resultingBytes > input.limitBytes) {
    throw quotaExceeded({
      usedBytes: input.usedBytes.toString(),
      reservedBytes: input.reservedBytes.toString(),
      limitBytes: input.limitBytes.toString(),
      requestedGrowthBytes: input.requestedGrowthBytes.toString()
    });
  }
}

export function referenceDelta(previousBytes: bigint | null, nextBytes: bigint | null): bigint {
  if (previousBytes !== null) assertByteCount(previousBytes, 'previous bytes');
  if (nextBytes !== null) assertByteCount(nextBytes, 'next bytes');
  return (nextBytes ?? 0n) - (previousBytes ?? 0n);
}

export function positivePart(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

export function utf8ByteLength(value: string): bigint {
  return BigInt(Buffer.byteLength(value, 'utf8'));
}

export function jsonbByteLengthFromPostgresOctetLength(value: number | string): bigint {
  const parsed = typeof value === 'number' ? BigInt(value) : BigInt(value);
  assertByteCount(parsed, 'JSONB byte length');
  return parsed;
}
