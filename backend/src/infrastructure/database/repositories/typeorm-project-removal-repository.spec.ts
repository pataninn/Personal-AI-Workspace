import type { DataSource } from 'typeorm';

import { TypeOrmProjectRemovalRepository } from '@/infrastructure/database/repositories/typeorm-project-removal-repository';
import type { IProjectRecoveryCleaner } from '@/modules/projects/repositories/project-removal-repository';

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const INPUT = { ownerId: 'owner-1', projectId: PROJECT_ID, expectedVersion: 3 };

function fixture(options: { readonly status?: string; readonly cleanup?: string; readonly version?: number; readonly missing?: boolean; readonly change?: string; readonly command?: string } = {}) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT "version"')) return options.missing ? [] : [{ version: options.version ?? 3 }];
    if (sql.includes('FROM "ai_runs"')) return [{ id: RUN_ID, status: options.status ?? 'succeeded', cleanup: options.cleanup ?? 'complete' }];
    if (sql.includes('FROM "ai_run_change_sets"')) return options.change ? [{ status: options.change }] : [];
    if (sql.includes('FROM "sandbox_commands"')) return options.command ? [{ status: options.command }] : [];
    return [];
  });
  const runner = { query, connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn() };
  const restore = jest.fn().mockResolvedValue(undefined);
  const purge = jest.fn().mockResolvedValue(undefined);
  const cleaner: jest.Mocked<IProjectRecoveryCleaner> = {
    quarantine: jest.fn().mockResolvedValue({ restore, purge }), restore, purge
  };
  const independentQuery = jest.fn().mockResolvedValue([]);
  // The fixture supplies only operations exercised by the adapter.
  const dataSource = { createQueryRunner: () => runner, query: independentQuery } as unknown as DataSource;
  return { repository: new TypeOrmProjectRemovalRepository(dataSource, cleaner), cleaner, independentQuery, ...runner };
}

describe('TypeOrmProjectRemovalRepository', () => {
  it.each(['pending_approval', 'ready', 'running', 'cancel_requested', 'review_required'])('blocks removal of projects with %s runs', async (status) => {
    const setup = fixture({ status });
    await expect(setup.repository.remove(INPUT)).rejects.toMatchObject({ code: 'PROJECT_REMOVAL_BUSY' });
    expect(setup.cleaner.quarantine).not.toHaveBeenCalled();
    expect(setup.commitTransaction).not.toHaveBeenCalled();
  });

  it.each([{ cleanup: 'unknown' }, { change: 'applying' }, { change: 'needs_manual_review' }, { command: 'running' }, { command: 'review_required' }])('blocks unresolved operation state %j', async (state) => {
    const setup = fixture(state);
    await expect(setup.repository.remove(INPUT)).rejects.toMatchObject({ code: 'PROJECT_REMOVAL_BUSY' });
    expect(setup.cleaner.quarantine).not.toHaveBeenCalled();
  });

  it.each([{ missing: true, code: 'PROJECT_NOT_FOUND' }, { version: 4, code: 'PROJECT_VERSION_CONFLICT' }])('rejects missing or stale project %j before cleanup', async ({ code, ...options }) => {
    const setup = fixture(options);
    await expect(setup.repository.remove(INPUT)).rejects.toMatchObject({ code });
    expect(setup.cleaner.quarantine).not.toHaveBeenCalled();
  });

  it('removes app data and purges backups only after commit', async () => {
    const setup = fixture();
    await setup.repository.remove(INPUT);
    expect(setup.query).toHaveBeenCalledWith('DELETE FROM "projects" WHERE "owner_id" = $1 AND "id" = $2', ['owner-1', PROJECT_ID]);
    expect(setup.cleaner.quarantine).toHaveBeenCalledWith([RUN_ID]);
    expect(setup.commitTransaction).toHaveBeenCalledTimes(1);
    expect(setup.cleaner.purge).toHaveBeenCalledTimes(1);
    expect(setup.cleaner.restore).not.toHaveBeenCalled();
    expect(setup.independentQuery).toHaveBeenLastCalledWith('DELETE FROM "project_removal_jobs" WHERE "project_id" = $1', [PROJECT_ID]);
  });

  it('reports a lock conflict as a busy project before filesystem operations', async () => {
    const setup = fixture();
    setup.query.mockRejectedValueOnce(Object.assign(new Error('lock busy'), { code: '55P03' }));
    await expect(setup.repository.remove(INPUT)).rejects.toMatchObject({ code: 'PROJECT_REMOVAL_BUSY' });
    expect(setup.cleaner.quarantine).not.toHaveBeenCalled();
  });

  it('restores quarantined backups when database commit fails', async () => {
    const setup = fixture();
    setup.commitTransaction.mockRejectedValue(new Error('commit failed'));
    setup.independentQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: PROJECT_ID }]);
    await expect(setup.repository.remove(INPUT)).rejects.toThrow('commit failed');
    expect(setup.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(setup.cleaner.restore).toHaveBeenCalledWith([RUN_ID]);
    expect(setup.cleaner.purge).not.toHaveBeenCalled();
  });

  it('retains the durable cleanup job if purging after commit fails', async () => {
    const setup = fixture();
    setup.cleaner.purge.mockRejectedValue(new Error('disk unavailable'));
    await expect(setup.repository.remove(INPUT)).rejects.toMatchObject({ code: 'PROJECT_REMOVAL_CLEANUP_PENDING' });
    expect(setup.commitTransaction).toHaveBeenCalledTimes(1);
    expect(setup.independentQuery).toHaveBeenCalledTimes(1);
    expect(setup.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('purges backups after an ambiguous commit response when committed project data is absent', async () => {
    const setup = fixture();
    setup.commitTransaction.mockRejectedValue(new Error('commit response lost'));
    setup.independentQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(setup.repository.remove(INPUT)).rejects.toThrow('commit response lost');
    expect(setup.cleaner.purge).toHaveBeenCalledWith([RUN_ID]);
    expect(setup.cleaner.restore).not.toHaveBeenCalled();
  });

  it('retains cleanup intent when restoring backups after rollback is unavailable', async () => {
    const setup = fixture();
    setup.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DELETE')) throw new Error('delete failed');
      if (sql.startsWith('SELECT "version"')) return [{ version: 3 }];
      if (sql.includes('FROM "ai_runs"')) return [{ id: RUN_ID, status: 'succeeded', cleanup: 'complete' }];
      return [];
    });
    setup.cleaner.restore.mockRejectedValue(new Error('disk unavailable'));
    await expect(setup.repository.remove(INPUT)).rejects.toThrow('disk unavailable');
    expect(setup.independentQuery).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('resumes cleanup after a crash (project exists: %s)', async (exists) => {
    const setup = fixture();
    setup.independentQuery.mockResolvedValueOnce([{ project_id: PROJECT_ID, run_ids: [RUN_ID] }]).mockResolvedValueOnce(exists ? [{ id: PROJECT_ID }] : []);
    await expect(setup.repository.cleanupPending()).resolves.toBe(1);
    expect(exists ? setup.cleaner.restore : setup.cleaner.purge).toHaveBeenCalledWith([RUN_ID]);
  });
});
