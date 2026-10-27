import type { QueryRunner } from 'typeorm';

import { CreateStorageRootMappings1710000030000 } from '@/infrastructure/database/migrations/1710000030000-create-storage-root-mappings';

describe('CreateStorageRootMappings1710000030000', () => {
  it('backfills attached roots and protects immutable owner-scoped locators', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const migration = new CreateStorageRootMappings1710000030000();

    await migration.up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM "projects"'));
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes('ORDER BY "owner_id", "relative_root_key"'))).toBe(true);
    expect(statements.some((sql) => sql.includes('ON DELETE RESTRICT'))).toBe(true);
    expect(statements.some((sql) => sql.includes('"state" = \'active\' AND "project_id" IS NOT NULL'))).toBe(true);
    expect(statements.some((sql) => sql.includes("current_setting('app.storage_root_removal_verified', true)"))).toBe(true);
    expect(statements.some((sql) => sql.includes("current_setting('app.storage_retained_orphan_registration', true)"))).toBe(true);
    expect(statements.some((sql) => sql.includes("NEW.\"state\" = 'retained' AND NEW.\"project_id\" IS NULL"))).toBe(true);
    expect(statements.some((sql) => sql.includes("'projects/' || NEW.\"locator_project_id\"::text"))).toBe(true);
  });

  it('refuses to remove root manifests during rollback while any mapping remains', async () => {
    const query = jest.fn().mockResolvedValue([{ has_mappings: true }]);
    const migration = new CreateStorageRootMappings1710000030000();

    await expect(migration.down({ query } as unknown as QueryRunner)).rejects.toThrow(/root mapping rollback is blocked/u);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
