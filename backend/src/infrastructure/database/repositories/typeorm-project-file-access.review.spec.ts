import type { DataSource } from 'typeorm';

import { TypeOrmProjectFileAccess } from '@/infrastructure/database/repositories/typeorm-project-file-access';

const INPUT = { ownerId: 'owner', projectId: 'project', writable: true };

function fixture(options: { missing?: boolean; archived?: boolean; busy?: boolean; activeChangeSet?: boolean; runningCommand?: boolean } = {}) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT id, relative_root')) return options.missing ? [] : [{ id: 'project', relative_root: 'folder', status: options.archived ? 'archived' : 'active' }];
    if (sql.includes('FROM ai_runs')) return options.busy ? [{ id: 'run' }] : [];
    if (sql.includes('ai_run_change_sets')) return options.activeChangeSet ? [{ id: 'change', status: 'applying' }] : [];
    if (sql.includes('sandbox_commands')) return options.runningCommand ? [{ id: 'command', status: 'running' }] : [];
    return [];
  });
  const transaction = jest.fn().mockImplementation(async (action: (manager: { query: typeof query }) => Promise<unknown>) => action({ query }));
  return { access: new TypeOrmProjectFileAccess({ transaction } as unknown as DataSource), query };
}

describe('manual file ownership/run guard review', () => {
  it('locks the owned project before file mutation and records activity only after success', async () => {
    const { access, query } = fixture();
    const action = jest.fn().mockImplementation(async () => {
      expect(query.mock.calls.some(([sql]: [string]) => sql.startsWith('UPDATE projects'))).toBe(false);
      return 'written';
    });
    await expect(access.execute(INPUT, action)).resolves.toBe('written');
    expect(query.mock.calls[0]).toEqual(['SELECT id, relative_root, status FROM projects WHERE owner_id=$1 AND id=$2 FOR UPDATE', ['owner', 'project']]);
    expect(action).toHaveBeenCalledWith({ projectId: 'project', relativeRoot: 'folder' });
    expect(query.mock.calls.at(-1)?.[0]).toContain('UPDATE projects SET updated_at=now()');
  });

  it.each([{ missing: true, code: 'PROJECT_NOT_FOUND' }, { archived: true, code: 'PROJECT_READ_ONLY' }, { busy: true, code: 'PROJECT_FILES_BUSY' }])('rejects inaccessible/read-only/busy state %s before touching the filesystem', async ({ code, ...options }) => {
    const { access } = fixture(options);
    const action = jest.fn();
    await expect(access.execute(INPUT, action)).rejects.toMatchObject({ code });
    expect(action).not.toHaveBeenCalled();
  });

  it('permits owned downloads during active runs without recording write activity', async () => {
    const { access, query } = fixture({ busy: true });
    await expect(access.execute({ ...INPUT, writable: false }, async () => 'bytes')).resolves.toBe('bytes');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([{ activeChangeSet: true }, { runningCommand: true }])('blocks manual writes while dependent work remains active %s', async (options) => {
    const { access } = fixture(options);
    const action = jest.fn();
    await expect(access.execute(INPUT, action)).rejects.toMatchObject({ code: 'PROJECT_FILES_BUSY' });
    expect(action).not.toHaveBeenCalled();
  });

  it('does not record recent file activity when the filesystem action fails', async () => {
    const { access, query } = fixture();
    await expect(access.execute(INPUT, async () => { throw new Error('filesystem failed'); })).rejects.toThrow('filesystem failed');
    expect(query.mock.calls.some(([sql]: [string]) => sql.startsWith('UPDATE projects'))).toBe(false);
  });
});
