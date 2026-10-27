import type { QueryRunner } from 'typeorm';

import { AddAccountStorageLimit1710000029000 } from '@/infrastructure/database/migrations/1710000029000-add-account-storage-limit';

describe('AddAccountStorageLimit1710000029000', () => {
  it('extends the shared account_limits row and starts accounts in reconciliation', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new AddAccountStorageLimit1710000029000();

    await migration.up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledTimes(9);
    expect(query.mock.calls[0]?.[0]).toContain('ALTER TABLE "account_limits"');
    expect(query.mock.calls[0]?.[0]).toContain('ADD COLUMN "storage_limit_bytes" bigint NULL');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('CREATE TABLE "account_limits"'))).toBe(false);
    expect(query.mock.calls[2]?.[0]).toContain("SELECT \"owner_id\", 'reconciling' FROM \"account_limits\"");
    expect(query.mock.calls[3]?.[0]).toContain('PRIMARY KEY ("owner_id", "resource_kind", "resource_key", "copy_key")');
    expect(query.mock.calls[3]?.[0]).toContain('length("copy_key") BETWEEN 1 AND 2048');
    expect(query.mock.calls[5]?.[0]).toContain('length("target_key") BETWEEN 1 AND 2048');
    expect(query.mock.calls[5]?.[0]).toContain('"reference_changes" jsonb NOT NULL');
    expect(query.mock.calls[5]?.[0]).toContain('"status" text NOT NULL DEFAULT \'pending\'');
    expect(query.mock.calls[7]?.[0]).toContain('CREATE TABLE "storage_filesystem_reservation_references"');
  });

  it.each([
    ['resource references', true, false, false, false, false],
    ['filesystem reservations', false, true, false, false, false],
    ['used bytes', false, false, true, false, false],
    ['reserved bytes', false, false, false, true, false],
    ['configured limits', false, false, false, false, true, false],
    ['reconciled accounts', false, false, false, false, false, true]
  ])('refuses rollback when %s remain', async (_kind, hasReferences, hasReservations, hasUsage, hasReservedBytes, hasConfiguredLimits, hasReconciledAccounts = false) => {
    const query = jest.fn().mockResolvedValueOnce([{
      has_references: hasReferences,
      has_reservations: hasReservations,
      has_usage: hasUsage,
      has_reserved_bytes: hasReservedBytes,
      has_configured_limits: hasConfiguredLimits,
      has_reconciled_accounts: hasReconciledAccounts
    }]);
    const migration = new AddAccountStorageLimit1710000029000();

    await expect(migration.down({ query } as unknown as QueryRunner)).rejects.toThrow('rollback is blocked');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('drops only storage-owned schema after an empty-state check', async () => {
    const query = jest.fn().mockResolvedValueOnce([{
      has_references: false,
      has_reservations: false,
      has_usage: false,
      has_reserved_bytes: false,
      has_configured_limits: false,
      has_reconciled_accounts: false
    }]).mockResolvedValue(undefined);
    const migration = new AddAccountStorageLimit1710000029000();

    await migration.down({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledTimes(9);
    expect(query.mock.calls[1]?.[0]).toBe('DROP INDEX "IDX_storage_filesystem_reservations_owner_status"');
    expect(query.mock.calls[3]?.[0]).toBe('DROP TABLE "storage_filesystem_reservation_references"');
    expect(query.mock.calls[8]?.[0]).toBe('ALTER TABLE "account_limits" DROP COLUMN "storage_limit_bytes"');
  });
});
