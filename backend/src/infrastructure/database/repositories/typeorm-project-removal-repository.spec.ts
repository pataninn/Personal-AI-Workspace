import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmProjectRemovalRepository } from '@/infrastructure/database/repositories/typeorm-project-removal-repository';
import type { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import type { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import type { IStorageRootMappingRepository } from '@/modules/storage-quotas/repositories/storage-root-mapping-repository';
import type { IProjectRecoveryCleaner } from '@/modules/projects/repositories/project-removal-repository';

const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const ROOT_KEY = 'managed:project-2';
const INPUT = { ownerId: OWNER_ID, projectId: PROJECT_ID, expectedVersion: 3 };

function fixture(options: { readonly status?: string; readonly cleanup?: string; readonly version?: number; readonly missing?: boolean; readonly quarantined?: boolean; readonly ambiguousCommit?: boolean } = {}) {
  const events: string[] = [];
  let active = false;
  let released = false;
  let jobInserted = false;
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('SELECT "relative_root_key" FROM "projects"')) return options.missing ? [] : [{ relative_root_key: ROOT_KEY }];
    if (sql.includes('FROM "storage_root_mappings"') && sql.includes("'active'")) return options.missing ? [] : [{ root_key: ROOT_KEY }];
    if (sql.includes('FROM "storage_root_mappings"') && sql.includes("'retained'")) return [{ root_key: ROOT_KEY }];
    if (sql.includes('FROM "storage_filesystem_reservations"')) return [];
    if (sql.startsWith('SELECT "id", "version"')) return options.missing ? [] : [{ id: PROJECT_ID, version: options.version ?? 3, relative_root_key: ROOT_KEY }];
    if (sql.includes('FROM "project_removal_jobs"') && sql.includes('FOR UPDATE')) {
      return jobInserted ? [{ owner_id: OWNER_ID, project_id: PROJECT_ID, storage_root_key: ROOT_KEY, run_ids: [RUN_ID], export_ids: [] }] : [];
    }
    if (sql.includes('FROM "ai_runs"')) return [{ id: RUN_ID, status: options.status ?? 'succeeded', cleanup: options.cleanup ?? 'complete' }];
    if (sql.includes('FROM "ai_run_change_sets"')) return [];
    if (sql.includes('FROM "sandbox_commands"')) return [];
    if (sql.startsWith('INSERT INTO "project_removal_jobs"')) { jobInserted = true; events.push('job-insert'); return []; }
    if (sql.startsWith('SELECT "id" FROM "projects"')) return [{ id: PROJECT_ID }];
    if (sql.startsWith('DELETE FROM "projects"')) { events.push('project-delete'); return [{ id: PROJECT_ID }]; }
    if (sql.startsWith('SELECT "id" FROM "conversations"') || sql.startsWith('SELECT m."id"')
      || sql.startsWith('SELECT "id" FROM "project_') || sql.startsWith('SELECT "id" FROM "ai_run_')
      || sql.startsWith('SELECT "id" FROM "sandbox_')) return [];
    return [];
  });
  const runner = {
    query,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockImplementation(async () => { active = true; events.push('transaction-start'); }),
    commitTransaction: jest.fn().mockImplementation(async () => {
      active = false;
      const commitCount = events.filter((event) => event === 'transaction-commit').length + 1;
      events.push('transaction-commit');
      if (options.ambiguousCommit && commitCount === 2) throw new Error('commit response lost');
    }),
    rollbackTransaction: jest.fn().mockImplementation(async () => { active = false; events.push('transaction-rollback'); }),
    release: jest.fn().mockImplementation(async () => { released = true; events.push('transaction-release'); }),
    get isTransactionActive() { return active; },
    get isReleased() { return released; }
  };
  const restore = jest.fn().mockImplementation(async () => { events.push(`restore:${active}`); });
  const purge = jest.fn().mockImplementation(async () => { events.push(`purge:${active}`); });
  const cleaner: jest.Mocked<IProjectRecoveryCleaner> = {
    quarantine: jest.fn().mockImplementation(async () => {
      events.push(`quarantine:${active}`);
      if (options.quarantined) throw new Error('quarantine unavailable');
      return { restore, purge };
    }), restore, purge
  };
  const runDatabaseMutation = jest.fn().mockImplementation(async (
    transaction: QueryRunner,
    _input: unknown,
    mutate: () => Promise<{ readonly result: unknown }>,
    hooks?: { readonly beforeReferences?: () => Promise<void> }
  ) => {
    await hooks?.beforeReferences?.();
    return (await mutate()).result;
  });
  const runMutation = jest.fn().mockImplementation(async (
    transaction: QueryRunner,
    _ownerId: string,
    mutate: () => Promise<unknown>,
    scope: { before: (tx: QueryRunner) => Promise<unknown>; after: (tx: QueryRunner, result: unknown) => Promise<unknown> },
    hooks?: { readonly beforeReferences?: () => Promise<void> }
  ) => {
    await hooks?.beforeReferences?.();
    await scope.before(transaction);
    const result = await mutate();
    await scope.after(transaction, result);
    return result;
  });
  const releaseRecoveryReferencesAfterVerifiedPurge = jest.fn().mockImplementation(async () => { events.push('recovery-refs-release'); });
  const storageQuotaRepository = { runDatabaseMutation, releaseRecoveryReferencesAfterVerifiedPurge };
  const storageAccounting = { runMutation };
  const rootMappings = { retainProjectRoot: jest.fn().mockResolvedValue({ rootKey: ROOT_KEY }) };
  const dataSourceQuery = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.startsWith('DELETE FROM "project_removal_jobs"')) { jobInserted = false; events.push('job-delete'); return []; }
    if (sql.includes('AS "blocked"')) return [{ blocked: false }];
    return [];
  });
  const dataSource = {
    createQueryRunner: () => runner,
    query: dataSourceQuery
  } as unknown as DataSource;
  const repository = new TypeOrmProjectRemovalRepository(
    dataSource,
    cleaner,
    storageAccounting as unknown as TypeOrmStorageContentAccounting,
    storageQuotaRepository as unknown as TypeOrmStorageQuotaRepository,
    rootMappings as unknown as IStorageRootMappingRepository
  );
  return {
    repository, cleaner, events, query, runner, runDatabaseMutation, runMutation,
    releaseRecoveryReferencesAfterVerifiedPurge, rootMappings, dataSourceQuery, restore, purge
  };
}

describe('TypeOrmProjectRemovalRepository', () => {
  it('commits the owner/root/run barrier before quarantine and retains folder references on deletion', async () => {
    const setup = fixture();
    await setup.repository.remove(INPUT);

    expect(setup.events.indexOf('job-insert')).toBeLessThan(setup.events.indexOf('transaction-commit'));
    expect(setup.events).toContain('quarantine:false');
    expect(setup.events).toContain('purge:false');
    expect(setup.rootMappings.retainProjectRoot).toHaveBeenCalledWith(setup.runner, { ownerId: OWNER_ID, projectId: PROJECT_ID });
    expect(setup.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE "storage_resource_references"'), [OWNER_ID, ROOT_KEY]);
    expect(setup.releaseRecoveryReferencesAfterVerifiedPurge).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID, [RUN_ID]);
    expect(setup.events.indexOf('purge:false')).toBeLessThan(setup.events.indexOf('recovery-refs-release'));
    expect(setup.events.indexOf('recovery-refs-release')).toBeLessThan(setup.events.indexOf('job-delete'));
  });

  it.each(['pending_approval', 'ready', 'running', 'cancel_requested', 'review_required'])('blocks removal while a run is %s', async (status) => {
    const setup = fixture({ status });
    await expect(setup.repository.remove(INPUT)).rejects.toMatchObject({ code: 'PROJECT_REMOVAL_BUSY' });
    expect(setup.cleaner.quarantine).not.toHaveBeenCalled();
    expect(setup.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "project_removal_jobs"'), expect.anything());
  });

  it('blocks unknown recovery state before the removal barrier is committed', async () => {
    const setup = fixture({ cleanup: 'unknown' });
    await expect(setup.repository.remove(INPUT)).rejects.toMatchObject({ code: 'PROJECT_REMOVAL_BUSY' });
    expect(setup.cleaner.quarantine).not.toHaveBeenCalled();
  });

  it.each([{ missing: true, code: 'PROJECT_NOT_FOUND' }, { version: 4, code: 'PROJECT_VERSION_CONFLICT' }])('rejects missing or stale projects before quarantine', async ({ code, ...options }) => {
    const setup = fixture(options);
    await expect(setup.repository.remove(INPUT)).rejects.toMatchObject({ code });
    expect(setup.cleaner.quarantine).not.toHaveBeenCalled();
  });

  it('leaves a committed barrier when quarantine is ambiguous', async () => {
    const setup = fixture({ quarantined: true });
    await expect(setup.repository.remove(INPUT)).rejects.toMatchObject({ code: 'PROJECT_REMOVAL_CLEANUP_PENDING' });
    expect(setup.events).toContain('quarantine:false');
    expect(setup.dataSourceQuery).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM "project_removal_jobs"'), expect.anything());
  });

  it('restores quarantined backups and removes the job when relational deletion rolls back', async () => {
    const setup = fixture();
    setup.rootMappings.retainProjectRoot.mockRejectedValueOnce(new Error('mapping unavailable'));
    await expect(setup.repository.remove(INPUT)).rejects.toThrow('mapping unavailable');
    expect(setup.restore).toHaveBeenCalledTimes(1);
    expect(setup.events).toContain('restore:false');
    expect(setup.events).toContain('job-delete');
    expect(setup.purge).not.toHaveBeenCalled();
  });

  it('retains the durable job when commit outcome is ambiguous', async () => {
    const setup = fixture({ ambiguousCommit: true });
    await expect(setup.repository.remove(INPUT)).rejects.toThrow('commit response lost');
    expect(setup.restore).not.toHaveBeenCalled();
    expect(setup.purge).not.toHaveBeenCalled();
    expect(setup.dataSourceQuery).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM "project_removal_jobs"'), expect.anything());
  });

  it('restores pending jobs when the project row still exists at startup', async () => {
    const setup = fixture();
    setup.dataSourceQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT "owner_id"')) return [{ owner_id: OWNER_ID, project_id: PROJECT_ID, storage_root_key: ROOT_KEY, run_ids: [RUN_ID], export_ids: [] }];
      if (sql.startsWith('SELECT "id", "relative_root_key"')) return [{ id: PROJECT_ID, relative_root_key: ROOT_KEY }];
      if (sql.includes('AS "blocked"')) return [{ blocked: false }];
      if (sql.startsWith('DELETE FROM')) { setup.events.push('job-delete'); return []; }
      return [];
    });
    await expect(setup.repository.cleanupPending()).resolves.toBe(1);
    expect(setup.cleaner.restore).toHaveBeenCalledWith([RUN_ID]);
    expect(setup.purge).not.toHaveBeenCalled();
    expect(setup.releaseRecoveryReferencesAfterVerifiedPurge).not.toHaveBeenCalled();
  });

  it('purges, releases recovery accounting, and then removes missing-project jobs on restart', async () => {
    const setup = fixture();
    setup.dataSourceQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT "owner_id"')) return [{ owner_id: OWNER_ID, project_id: PROJECT_ID, storage_root_key: ROOT_KEY, run_ids: [RUN_ID], export_ids: [] }];
      if (sql.startsWith('SELECT "id", "relative_root_key"')) return [];
      if (sql.includes('AS "blocked"')) return [{ blocked: false }];
      if (sql.includes('FROM "storage_root_mappings"')) return [{ root_key: ROOT_KEY }];
      if (sql.startsWith('DELETE FROM')) { setup.events.push('job-delete'); return []; }
      return [];
    });
    await expect(setup.repository.cleanupPending()).resolves.toBe(1);
    expect(setup.cleaner.purge).toHaveBeenCalledWith([RUN_ID]);
    expect(setup.releaseRecoveryReferencesAfterVerifiedPurge).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID, [RUN_ID]);
    expect(setup.events.indexOf('purge:false')).toBeLessThan(setup.events.indexOf('recovery-refs-release'));
    expect(setup.events.indexOf('recovery-refs-release')).toBeLessThan(setup.events.indexOf('job-delete'));
  });
});
