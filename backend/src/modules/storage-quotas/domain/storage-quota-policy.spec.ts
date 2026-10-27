import { accountingUnavailable, StorageQuotaError } from '@/modules/storage-quotas/domain/storage-quota-errors';
import { assertStorageAdmission, jsonbByteLengthFromPostgresOctetLength, referenceDelta, utf8ByteLength } from '@/modules/storage-quotas/domain/storage-quota-policy';

describe('storage quota policy', () => {
  it('measures stored text as UTF-8 bytes rather than JavaScript characters', () => {
    expect(utf8ByteLength('café 🛰️')).toBe(BigInt(Buffer.byteLength('café 🛰️', 'utf8')));
    expect(utf8ByteLength('é')).toBe(2n);
  });

  it('uses PostgreSQL-reported JSONB octets as an exact integer', () => {
    expect(jsonbByteLengthFromPostgresOctetLength('5000000000')).toBe(5_000_000_000n);
    expect(jsonbByteLengthFromPostgresOctetLength(128)).toBe(128n);
  });

  it('admits exact decimal five-gigabyte usage and denies one byte beyond the limit', () => {
    const limitBytes = 5_000_000_000n;
    expect(() => assertStorageAdmission({
      state: 'ready', usedBytes: limitBytes - 1n, reservedBytes: 0n, limitBytes, requestedGrowthBytes: 1n
    })).not.toThrow();
    expect(() => assertStorageAdmission({
      state: 'ready', usedBytes: limitBytes - 1n, reservedBytes: 0n, limitBytes, requestedGrowthBytes: 2n
    })).toThrow(expect.objectContaining({ code: 'STORAGE_QUOTA_EXCEEDED', statusCode: 413 }));
  });

  it('allows non-positive deltas while over limit but fails closed for positive growth while unreconciled', () => {
    expect(() => assertStorageAdmission({
      state: 'ready', usedBytes: 12n, reservedBytes: 1n, limitBytes: 10n, requestedGrowthBytes: 0n
    })).not.toThrow();
    expect(() => assertStorageAdmission({
      state: 'ready', usedBytes: 12n, reservedBytes: 1n, limitBytes: 10n, requestedGrowthBytes: 1n
    })).toThrow(StorageQuotaError);
    expect(() => assertStorageAdmission({
      state: 'reconciling', usedBytes: 0n, reservedBytes: 0n, limitBytes: null, requestedGrowthBytes: 1n
    })).toThrow(accountingUnavailable());
  });

  it('computes separate-copy deltas without content-hash deduplication', () => {
    expect(referenceDelta(null, 10n) + referenceDelta(null, 10n)).toBe(20n);
    expect(referenceDelta(10n, 6n)).toBe(-4n);
    expect(referenceDelta(10n, null)).toBe(-10n);
  });
});
