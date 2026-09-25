import {
  ProjectRootReparsePointError,
  WorkspaceBoundaryUnavailableError
} from '@/modules/projects/domain/project-errors';
import {
  WorkspaceBoundaryAdapter,
  type WorkspaceFileSystem,
  type WorkspaceStats
} from '@/infrastructure/workspace/workspace-boundary';

function stats(options: { directory?: boolean; file?: boolean; symbolicLink?: boolean; reparsePoint?: boolean } = {}): WorkspaceStats {
  return {
    isDirectory: () => options.directory === true,
    isFile: () => options.file === true,
    isSymbolicLink: () => options.symbolicLink === true,
    isReparsePoint: () => options.reparsePoint === true
  };
}

function fakeFileSystem(entries: ReadonlyMap<string, WorkspaceStats>, identity = 'host-marker'): WorkspaceFileSystem {
  return {
    lstat: async (filePath) => {
      const entry = entries.get(filePath);
      if (!entry) {
        throw new Error(`missing ${filePath}`);
      }
      return entry;
    },
    readFile: async () => identity,
    realpath: async (filePath) => filePath
  };
}

describe('WorkspaceBoundaryAdapter', () => {
  it('accepts a verified container root and existing relative directory', async () => {
    const fileSystem = fakeFileSystem(new Map([
      ['/workspace', stats({ directory: true })],
      ['/workspace/.identity', stats({ file: true })],
      ['/workspace/apps', stats({ directory: true })],
      ['/workspace/apps/website', stats({ directory: true })]
    ]));
    const adapter = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace',
      identityFile: '/workspace/.identity',
      expectedIdentity: 'host-marker',
      fileSystem
    });

    await expect(adapter.getSnapshot()).resolves.toEqual({ status: 'ready' });
    await expect(adapter.validateProjectRoot('apps\\website')).resolves.toBe('apps/website');
  });

  it('accepts the workspace root as a project only after the root identity checks pass', async () => {
    const adapter = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace',
      identityFile: '/workspace/.identity',
      expectedIdentity: 'host-marker',
      fileSystem: fakeFileSystem(new Map([
        ['/workspace', stats({ directory: true })],
        ['/workspace/.identity', stats({ file: true })]
      ]))
    });

    await expect(adapter.validateProjectRoot('.')).resolves.toBe('.');
  });

  it('fails closed for identity mismatch and reparse-point components', async () => {
    const identityMismatch = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace',
      identityFile: '/workspace/.identity',
      expectedIdentity: 'different',
      fileSystem: fakeFileSystem(new Map([
        ['/workspace', stats({ directory: true })],
        ['/workspace/.identity', stats({ file: true })]
      ]))
    });
    await expect(identityMismatch.assertReady()).rejects.toBeInstanceOf(WorkspaceBoundaryUnavailableError);

    const reparse = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace',
      identityFile: '/workspace/.identity',
      expectedIdentity: 'host-marker',
      fileSystem: fakeFileSystem(new Map([
        ['/workspace', stats({ directory: true })],
        ['/workspace/.identity', stats({ file: true })],
        ['/workspace/apps', stats({ directory: true, reparsePoint: true })]
      ]))
    });
    await expect(reparse.validateProjectRoot('apps/site')).rejects.toBeInstanceOf(ProjectRootReparsePointError);
  });

  it('rejects a container root that is itself a symbolic link', async () => {
    const adapter = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace',
      identityFile: '/workspace/.identity',
      expectedIdentity: 'host-marker',
      fileSystem: fakeFileSystem(new Map([
        ['/workspace', stats({ directory: true, symbolicLink: true })]
      ]))
    });
    await expect(adapter.getSnapshot()).resolves.toMatchObject({ status: 'unavailable' });
    await expect(adapter.assertReady()).rejects.toBeInstanceOf(WorkspaceBoundaryUnavailableError);
  });

  it('rejects a canonical project path that escapes the verified workspace', async () => {
    const fileSystem = fakeFileSystem(new Map([
      ['/workspace', stats({ directory: true })],
      ['/workspace/.identity', stats({ file: true })],
      ['/workspace/apps', stats({ directory: true })],
      ['/workspace/apps/website', stats({ directory: true })]
    ]));
    const escapingFileSystem: WorkspaceFileSystem = {
      ...fileSystem,
      realpath: async (filePath) => filePath === '/workspace/apps/website' ? '/outside/website' : filePath
    };
    const adapter = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace',
      identityFile: '/workspace/.identity',
      expectedIdentity: 'host-marker',
      fileSystem: escapingFileSystem
    });

    await expect(adapter.validateProjectRoot('apps/website')).rejects.toMatchObject({ code: 'PROJECT_ROOT_INVALID' });
  });

  it('returns the canonical relative value when a Windows 8.3 alias resolves to a long path', async () => {
    const aliasPath = '/workspace/APPS~1/WEBSIT~1';
    const canonicalPath = '/workspace/apps/website';
    const entries = new Map([
      ['/workspace', stats({ directory: true })],
      ['/workspace/.identity', stats({ file: true })],
      [aliasPath.split('/').slice(0, 3).join('/'), stats({ directory: true })],
      [aliasPath, stats({ directory: true })]
    ]);
    const baseFileSystem = fakeFileSystem(entries);
    const fileSystem: WorkspaceFileSystem = {
      ...baseFileSystem,
      realpath: async (filePath) => filePath === aliasPath ? canonicalPath : filePath
    };
    const adapter = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace',
      identityFile: '/workspace/.identity',
      expectedIdentity: 'host-marker',
      fileSystem
    });

    await expect(adapter.validateProjectRoot('APPS~1/WEBSIT~1')).resolves.toBe('apps/website');
  });
});
