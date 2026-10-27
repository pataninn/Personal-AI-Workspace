import type { QueryRunner } from 'typeorm';

import { AddAccountIdentity1710000026000 } from '@/infrastructure/database/migrations/1710000026000-add-account-identity';

describe('AddAccountIdentity1710000026000', () => {
  it('backfills the legacy owner without changing its account data and adds constrained identity fields', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new AddAccountIdentity1710000026000();

    await migration.up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0]?.[0]).toContain('ALTER COLUMN "password_hash" DROP NOT NULL');
    expect(query.mock.calls[1]?.[0]).toContain('ADD COLUMN "account_kind" text NOT NULL DEFAULT \'regular\'');
    expect(query.mock.calls[2]?.[0]).toContain("WHEN \"scope_key\" = 'local' THEN 'owner'");
    expect(query.mock.calls[2]?.[0]).toContain("WHEN \"scope_key\" = 'local' THEN 'admin' ELSE 'user'");
    expect(query.mock.calls[2]?.[0]).toContain("'legacy-' || replace(\"id\"::text, '-', '')");
    expect(query.mock.calls[3]?.[0]).toContain('CHK_users_identity_shape');
  });

  it.each([
    ['managed accounts', true, false],
    ['passwordless accounts', false, true]
  ])('refuses rollback while %s exist', async (_kind, hasManagedAccounts, hasPasswordlessAccounts) => {
    const query = jest.fn().mockResolvedValueOnce([{
      has_managed_accounts: hasManagedAccounts,
      has_passwordless_accounts: hasPasswordlessAccounts
    }]);
    const migration = new AddAccountIdentity1710000026000();

    await expect(migration.down({ query } as unknown as QueryRunner)).rejects.toThrow('rollback is blocked');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reverses identity columns after checking the rollback boundary', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ has_managed_accounts: false, has_passwordless_accounts: false }])
      .mockResolvedValue(undefined);
    const migration = new AddAccountIdentity1710000026000();

    await migration.down({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledTimes(8);
    expect(query).toHaveBeenLastCalledWith('ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL');
  });
});
