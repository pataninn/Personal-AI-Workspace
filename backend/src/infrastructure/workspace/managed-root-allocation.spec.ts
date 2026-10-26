import { WorkspaceBoundaryAdapter, type WorkspaceFileSystem, type WorkspaceStats } from './workspace-boundary';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const ROOT = '/account-workspaces';
const MARKER = `${ROOT}/.personal-ai-managed-storage-identity`;
const PROJECT_PATH = `${ROOT}/${OWNER}/projects/${PROJECT}`;

function fixture() {
  const directory = (ino: number): WorkspaceStats => ({
    dev: 1, ino, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false
  });
  const file: WorkspaceStats = { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
  const entries = new Map<string, WorkspaceStats>([['/workspace', directory(99)], ['/workspace/.identity', file], [ROOT, directory(1)], [MARKER, {
    isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false
  }]]);
  let nextInode = 2;
  let children: string[] = [];
  const rmdir = jest.fn(async (filePath: string) => {
    if (children.length) throw Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' });
    entries.delete(filePath);
  });
  const fileSystem: WorkspaceFileSystem = {
    lstat: async (filePath) => {
      const entry = entries.get(filePath);
      if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return entry;
    },
    mkdir: async (filePath) => {
      if (entries.has(filePath)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      entries.set(filePath, directory(nextInode++));
    },
    realpath: async (filePath) => filePath,
    readFile: async () => 'marker',
    readdir: async () => children,
    rmdir
  };
  const makeAdapter = () => new WorkspaceBoundaryAdapter({
    containerRoot: '/workspace', identityFile: '/workspace/.identity', expectedIdentity: 'marker',
    managedContainerRoot: ROOT, managedIdentityFile: MARKER, managedExpectedIdentity: 'marker', fileSystem
  });
  return { adapter: makeAdapter(), makeAdapter, entries, rmdir, directory, setChildren: (value: string[]) => { children = value; } };
}

describe('managed allocation rollback', () => {
  it('removes only the proven empty allocation and allows retry after adapter restart', async () => {
    const { adapter, makeAdapter, entries, rmdir } = fixture();
    const allocation = await adapter.allocateManagedProjectRoot(OWNER, PROJECT);
    await allocation.discardIfEmpty();
    expect(rmdir).toHaveBeenCalledWith(PROJECT_PATH);
    expect(entries.has(`${ROOT}/${OWNER}/projects`)).toBe(true);
    await expect(makeAdapter().getManagedSnapshot()).resolves.toEqual({ status: 'ready' });
    await expect(makeAdapter().allocateManagedProjectRoot(OWNER, PROJECT)).resolves.toMatchObject({ relativeRoot: `projects/${PROJECT}` });
  });

  it('retains nonempty and replaced roots', async () => {
    const nonempty = fixture();
    const allocation = await nonempty.adapter.allocateManagedProjectRoot(OWNER, PROJECT);
    nonempty.setChildren(['user-content.txt']);
    await expect(allocation.discardIfEmpty()).rejects.toThrow();
    expect(nonempty.rmdir).not.toHaveBeenCalled();
    const replaced = fixture();
    const replacedAllocation = await replaced.adapter.allocateManagedProjectRoot(OWNER, PROJECT);
    replaced.entries.set(PROJECT_PATH, replaced.directory(999));
    await expect(replacedAllocation.discardIfEmpty()).rejects.toThrow();
    expect(replaced.rmdir).not.toHaveBeenCalled();
  });
});
