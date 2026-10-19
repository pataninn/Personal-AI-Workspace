import type { DataSource } from 'typeorm';

import { TypeOrmProjectFileAccess } from '@/infrastructure/database/repositories/typeorm-project-file-access';
import type { StorageTrustedFileScope } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { IStorageRootMappingRepository } from '@/modules/storage-quotas/repositories/storage-root-mapping-repository';

const OWNER_ID = 'owner';
const PROJECT_ID = 'project';
const ROOT_KEY = 'legacy/project';
const PROJECT = { ownerId: OWNER_ID, projectId: PROJECT_ID, storageKind: 'legacy' as const, relativeRoot: 'project' };
const TRUSTED_SCOPE: StorageTrustedFileScope = {
  ownerId: OWNER_ID,
  projectId: PROJECT_ID,
  roots: [{ ...PROJECT, locatorProjectId: PROJECT_ID, rootKey: ROOT_KEY }]
};

function fixture(options: { disabled?: boolean; missing?: boolean; rootless?: boolean; archived?: boolean; busy?: boolean; activeChangeSet?: boolean; runningCommand?: boolean } = {}) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT id FROM users')) return options.disabled ? [] : [{ id: OWNER_ID }];
    if (sql.startsWith('SELECT id, relative_root_key')) return options.missing ? [] : [{ id: PROJECT_ID, relative_root_key: options.rootless ? null : ROOT_KEY, status: options.archived ? 'archived' : 'active' }];
    if (sql.startsWith('SELECT status FROM projects')) return [{ status: options.archived ? 'archived' : 'active' }];
    if (sql.includes('FROM ai_runs')) return options.busy ? [{ id: 'run' }] : [];
    if (sql.includes('ai_run_change_sets')) return options.activeChangeSet ? [{ id: 'change', status: 'applying' }] : [];
    if (sql.includes('sandbox_commands')) return options.runningCommand ? [{ id: 'command', status: 'running' }] : [];
    return [];
  });
  const transaction = jest.fn().mockImplementation(async (action: (manager: { query: typeof query }) => Promise<unknown>) => action({ query }));
  const rootMappings: jest.Mocked<IStorageRootMappingRepository> = {
    resolveTrustedScope: jest.fn().mockResolvedValue(TRUSTED_SCOPE),
    listMappings: jest.fn(),
    registerVerifiedRetainedManagedOrphan: jest.fn(),
    retainProjectRoot: jest.fn(),
    deleteVerifiedRetained: jest.fn()
  };
  const dataSource = { transaction, query } as unknown as DataSource;
  return { access: new TypeOrmProjectFileAccess(dataSource, rootMappings), query, transaction, rootMappings };
}

describe('TypeOrmProjectFileAccess', () => {
  it('commits trusted-root resolution before starting the filesystem read', async () => {
    const setup = fixture();
    let transactionOpen = false;
    setup.transaction.mockImplementation(async (action) => {
      transactionOpen = true;
      try { return await action({ query: setup.query }); }
      finally { transactionOpen = false; }
    });
    const action = jest.fn(async () => {
      expect(transactionOpen).toBe(false);
      return 'read-result';
    });

    await expect(setup.access.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID }, action)).resolves.toBe('read-result');
    expect(setup.query.mock.calls[0]).toEqual([
      'SELECT id FROM users WHERE id=$1 AND is_active=true AND (expires_at IS NULL OR expires_at > now()) FOR SHARE', [OWNER_ID]
    ]);
    expect(setup.rootMappings.resolveTrustedScope).toHaveBeenCalledWith(expect.objectContaining({ query: expect.any(Function) }), {
      ownerId: OWNER_ID, projectId: PROJECT_ID, rootKeys: [ROOT_KEY]
    });
    expect(action).toHaveBeenCalledWith(PROJECT);
  });

  it('rejects disabled accounts, missing projects, and planning-only projects before file access', async () => {
    for (const [options, expected] of [
      [{ disabled: true }, { name: 'UnauthenticatedError' }],
      [{ missing: true }, { code: 'PROJECT_NOT_FOUND' }],
      [{ rootless: true }, { code: 'PROJECT_ROOT_NOT_ATTACHED' }]
    ] as const) {
      const setup = fixture(options);
      const action = jest.fn();
      await expect(setup.access.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID }, action)).rejects.toMatchObject(expected);
      expect(action).not.toHaveBeenCalled();
    }
  });

  it.each([{ archived: true, code: 'PROJECT_READ_ONLY' }, { busy: true, code: 'PROJECT_FILES_BUSY' }, { activeChangeSet: true, code: 'PROJECT_FILES_BUSY' }, { runningCommand: true, code: 'PROJECT_FILES_BUSY' }])(
    'blocks writes when project state is not safe: %j', async ({ code, ...options }) => {
      const setup = fixture(options);
      await expect(setup.access.authorizeMutation({ ownerId: OWNER_ID, projectId: PROJECT_ID })).rejects.toMatchObject({ code });
    }
  );

  it('revalidates the mapping and writable project state in the durable reservation transaction', async () => {
    const setup = fixture();
    const access = await setup.access.authorizeMutation({ ownerId: OWNER_ID, projectId: PROJECT_ID });
    const transaction = { query: setup.query };

    await expect(access.resolveTrustedScope(transaction, { ownerId: OWNER_ID, projectId: PROJECT_ID, rootKeys: [ROOT_KEY] })).resolves.toEqual(TRUSTED_SCOPE);
    expect(setup.rootMappings.resolveTrustedScope).toHaveBeenCalledTimes(2);
    expect(setup.query.mock.calls.some(([sql]) => String(sql).startsWith('SELECT status FROM projects'))).toBe(true);
  });

  it('rejects a scope request that attempts a different owner or root key', async () => {
    const setup = fixture();
    const access = await setup.access.authorizeMutation({ ownerId: OWNER_ID, projectId: PROJECT_ID });
    await expect(access.resolveTrustedScope({ query: setup.query }, { ownerId: 'other', projectId: PROJECT_ID, rootKeys: [ROOT_KEY] }))
      .rejects.toMatchObject({ code: 'STORAGE_ACCOUNTING_UNAVAILABLE', statusCode: 503 });
    expect(setup.rootMappings.resolveTrustedScope).toHaveBeenCalledTimes(1);
  });
});
