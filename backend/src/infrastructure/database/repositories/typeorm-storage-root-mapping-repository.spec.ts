import type { DataSource } from 'typeorm';

import { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import type { StorageQuotaTransaction } from '@/modules/storage-quotas/repositories/storage-quota-repository';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ROOT_KEY = `projects/${PROJECT_ID}`;

const activeRow = {
  owner_id: OWNER_ID,
  project_id: PROJECT_ID,
  locator_project_id: PROJECT_ID,
  root_key: ROOT_KEY,
  storage_kind: 'managed' as const,
  relative_root: ROOT_KEY,
  state: 'active' as const
};

describe('TypeOrmStorageRootMappingRepository', () => {
  it('resolves only the exact persisted project mapping, including archived attached projects', async () => {
    const query = jest.fn().mockResolvedValue([activeRow]);
    const repository = new TypeOrmStorageRootMappingRepository({} as DataSource);

    await expect(repository.resolveTrustedScope({ query } as unknown as StorageQuotaTransaction, {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      rootKeys: [ROOT_KEY]
    })).resolves.toEqual({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      roots: [{
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        locatorProjectId: PROJECT_ID,
        rootKey: ROOT_KEY,
        storageKind: 'managed',
        relativeRoot: ROOT_KEY
      }]
    });
    expect(query.mock.calls[0]?.[0]).toContain('p."relative_root_key" = m."root_key"');
    expect(query.mock.calls[0]?.[0]).not.toContain('p."status"');
    expect(query.mock.calls[0]?.[1]).toEqual([OWNER_ID, PROJECT_ID, [ROOT_KEY]]);
  });

  it('rejects an incomplete root set rather than returning a partial trusted scope', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repository = new TypeOrmStorageRootMappingRepository({} as DataSource);

    await expect(repository.resolveTrustedScope({ query } as unknown as StorageQuotaTransaction, {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      rootKeys: [ROOT_KEY]
    })).rejects.toThrow(/trusted storage root is unavailable/u);
  });

  it('keeps a detached root tied to its immutable locator and permits release only with no refs or pending operations', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([[{
        ...activeRow,
        project_id: null,
        state: 'retained'
      }], 1])
      .mockResolvedValueOnce([{ has_references: false, has_reservations: false }])
      .mockResolvedValueOnce([{ setting: `${OWNER_ID}:${ROOT_KEY}` }])
      .mockResolvedValueOnce([[{
        ...activeRow,
        project_id: null,
        state: 'retained'
      }], 1]);
    const repository = new TypeOrmStorageRootMappingRepository({} as DataSource);
    const transaction = { query } as unknown as StorageQuotaTransaction;

    await expect(repository.retainProjectRoot(transaction, { ownerId: OWNER_ID, projectId: PROJECT_ID }))
      .resolves.toMatchObject({ state: 'retained', projectId: null, locatorProjectId: PROJECT_ID, relativeRoot: ROOT_KEY });
    await repository.deleteVerifiedRetained(transaction, { ownerId: OWNER_ID, rootKey: ROOT_KEY });

    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.at(-2)?.[0]).toContain("set_config('app.storage_root_removal_verified'");
    expect(query.mock.calls.at(-1)?.[0]).toContain('DELETE FROM "storage_root_mappings"');
  });

  it('refuses to remove a retained mapping while references remain', async () => {
    const query = jest.fn().mockResolvedValue([{ has_references: true, has_reservations: false }]);
    const repository = new TypeOrmStorageRootMappingRepository({} as DataSource);

    await expect(repository.deleteVerifiedRetained({ query } as unknown as StorageQuotaTransaction, {
      ownerId: OWNER_ID,
      rootKey: ROOT_KEY
    })).rejects.toThrow(/references or unresolved operations remain/u);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('registers a verified managed orphan as retained under the owner limits and root lock', async () => {
    const orphanId = '33333333-3333-4333-8333-333333333333';
    const orphanRoot = `projects/${orphanId}`;
    const orphanRow = {
      owner_id: OWNER_ID,
      project_id: null,
      locator_project_id: orphanId,
      root_key: orphanRoot,
      storage_kind: 'managed' as const,
      relative_root: orphanRoot,
      state: 'retained' as const
    };
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: OWNER_ID }])
      .mockResolvedValueOnce([{ owner_id: OWNER_ID }])
      .mockResolvedValueOnce([{ accounting_state: 'unavailable' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ root_key: '.', storage_kind: 'legacy', relative_root: '.' }])
      .mockResolvedValueOnce([{ storage_kind: 'legacy', relative_root: '.' }])
      .mockResolvedValueOnce([{ setting: `${OWNER_ID}:${orphanId}:${orphanRoot}` }])
      .mockResolvedValueOnce([[orphanRow], 1]);
    const runner = {
      query,
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined)
    };
    const repository = new TypeOrmStorageRootMappingRepository({ createQueryRunner: () => runner } as unknown as DataSource);

    await expect(repository.registerVerifiedRetainedManagedOrphan({ ownerId: OWNER_ID, locatorProjectId: orphanId }))
      .resolves.toMatchObject({
        ownerId: OWNER_ID, projectId: null, locatorProjectId: orphanId,
        rootKey: orphanRoot, storageKind: 'managed', relativeRoot: orphanRoot, state: 'retained'
      });
    expect(query.mock.calls[0]?.[0]).toContain('FROM "users"');
    expect(query.mock.calls[1]?.[0]).toContain('FROM "account_limits"');
    expect(query.mock.calls[1]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls[3]?.[0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[8]?.[0]).toContain("set_config('app.storage_retained_orphan_registration'");
    expect(query.mock.calls[9]?.[1]).toEqual([OWNER_ID, orphanId, orphanRoot, orphanRoot]);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('does not register an orphan when the account is ready', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: OWNER_ID }])
      .mockResolvedValueOnce([{ owner_id: OWNER_ID }])
      .mockResolvedValueOnce([{ accounting_state: 'ready' }]);
    const runner = {
      query,
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined)
    };
    const repository = new TypeOrmStorageRootMappingRepository({ createQueryRunner: () => runner } as unknown as DataSource);

    await expect(repository.registerVerifiedRetainedManagedOrphan({
      ownerId: OWNER_ID,
      locatorProjectId: '33333333-3333-4333-8333-333333333333'
    })).rejects.toThrow(/only while accounting is unavailable/u);
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(3);
  });
});
