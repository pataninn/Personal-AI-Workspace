import {
  ProjectRootReparsePointError,
  WorkspaceBoundaryUnavailableError,
  WorkspaceStorageUnavailableError
} from '@/modules/projects/domain/project-errors';
import {
  WorkspaceBoundaryAdapter,
  type WorkspaceFileSystem,
  type WorkspaceStats
} from '@/infrastructure/workspace/workspace-boundary';

function stats(options: { directory?: boolean; file?: boolean; symbolicLink?: boolean; reparsePoint?: boolean; dev?: number; ino?: number } = {}): WorkspaceStats {
  return {
    ...(options.dev === undefined ? {} : { dev: options.dev }),
    ...(options.ino === undefined ? {} : { ino: options.ino }),
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
    realpath: async (filePath) => filePath,
    readdir: async (directoryPath) => {
      const prefix = `${directoryPath}/`;
      const names = new Set<string>();
      for (const filePath of entries.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const suffix = filePath.slice(prefix.length);
        const firstSegment = suffix.split('/')[0];
        if (firstSegment) names.add(firstSegment);
      }
      return [...names].sort();
    }
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

  it('allocates and resolves account-owned managed roots without using the reserved legacy mount', async () => {
    const entries = new Map<string, WorkspaceStats>([
      ['/workspace', stats({ directory: true, dev: 1, ino: 1 })],
      ['/workspace/.identity', stats({ file: true })],
      ['/account-workspaces', stats({ directory: true, dev: 2, ino: 2 })],
      ['/account-workspaces/.personal-ai-managed-storage-identity', stats({ file: true })]
    ]);
    let nextInode = 3;
    const fileSystem: WorkspaceFileSystem = {
      lstat: async (filePath) => {
        const entry = entries.get(filePath);
        if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return entry;
      },
      mkdir: async (filePath) => {
        if (entries.has(filePath)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        entries.set(filePath, stats({ directory: true, dev: 2, ino: nextInode++ }));
      },
      readFile: async (filePath) => filePath === '/workspace/.identity' ? 'legacy-marker' : 'managed-marker',
      realpath: async (filePath) => filePath
    };
    const adapter = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace', identityFile: '/workspace/.identity', expectedIdentity: 'legacy-marker',
      managedContainerRoot: '/account-workspaces',
      managedIdentityFile: '/account-workspaces/.personal-ai-managed-storage-identity',
      managedExpectedIdentity: 'managed-marker',
      legacyOwnerId: async () => '11111111-1111-4111-8111-111111111111',
      fileSystem
    });
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const projectId = '22222222-2222-4222-8222-222222222222';

    await expect(adapter.getManagedSnapshot()).resolves.toEqual({ status: 'ready' });
    await expect(adapter.createManagedProjectRoot(ownerId, projectId)).resolves.toBe(`projects/${projectId}`);
    await expect(adapter.resolveProjectRoot({ ownerId, projectId, storageKind: 'managed', relativeRoot: `projects/${projectId}` }))
      .resolves.toEqual({ canonicalRoot: '/account-workspaces', canonicalProjectRoot: `/account-workspaces/${ownerId}/projects/${projectId}` });
    await expect(adapter.resolveProjectRoot({ ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId, storageKind: 'legacy', relativeRoot: 'legacy-project' }))
      .rejects.toBeInstanceOf(WorkspaceBoundaryUnavailableError);
  });

  it('removes only the manifested managed project child after validating its complete tree', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const projectId = '22222222-2222-4222-8222-222222222222';
    const projectPath = `/account-workspaces/${ownerId}/projects/${projectId}`;
    const entries = new Map<string, WorkspaceStats>([
      ['/workspace', stats({ directory: true, dev: 1, ino: 1 })], ['/workspace/.identity', stats({ file: true })],
      ['/account-workspaces', stats({ directory: true, dev: 2, ino: 2 })],
      ['/account-workspaces/.personal-ai-managed-storage-identity', stats({ file: true })],
      [`/account-workspaces/${ownerId}`, stats({ directory: true, dev: 2, ino: 3 })],
      [`/account-workspaces/${ownerId}/projects`, stats({ directory: true, dev: 2, ino: 4 })],
      [projectPath, stats({ directory: true, dev: 2, ino: 5 })],
      [`${projectPath}/note.txt`, stats({ file: true })]
    ]);
    const fileSystem: WorkspaceFileSystem = {
      lstat: async (filePath) => {
        const entry = entries.get(filePath);
        if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return entry;
      },
      readFile: async (filePath) => filePath === '/workspace/.identity' ? 'host-marker' : 'managed-marker',
      realpath: async (filePath) => filePath,
      readdir: async (directoryPath) => [...entries.keys()]
        .filter((entry) => entry.startsWith(`${directoryPath}/`))
        .map((entry) => entry.slice(directoryPath.length + 1).split('/')[0]!)
        .filter((entry, index, all) => all.indexOf(entry) === index),
      unlink: async (filePath) => { entries.delete(filePath); },
      rmdir: async (directoryPath) => {
        if ([...entries.keys()].some((entry) => entry.startsWith(`${directoryPath}/`))) throw new Error('not empty');
        entries.delete(directoryPath);
      }
    };
    const adapter = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace', identityFile: '/workspace/.identity', expectedIdentity: 'host-marker',
      managedContainerRoot: '/account-workspaces',
      managedIdentityFile: '/account-workspaces/.personal-ai-managed-storage-identity',
      managedExpectedIdentity: 'managed-marker', fileSystem
    });

    await adapter.removeManagedProjectRoot(ownerId, projectId);

    expect(entries.has(projectPath)).toBe(false);
    expect(entries.has(`/account-workspaces/${ownerId}`)).toBe(true);
    expect(entries.has(`/account-workspaces/${ownerId}/projects`)).toBe(true);
    expect(entries.has('/account-workspaces')).toBe(true);
  });

  it('refuses the whole root removal before deleting files when its tree contains a reparse point', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const projectId = '22222222-2222-4222-8222-222222222222';
    const projectPath = `/account-workspaces/${ownerId}/projects/${projectId}`;
    const entries = new Map<string, WorkspaceStats>([
      ['/workspace', stats({ directory: true, dev: 1, ino: 1 })], ['/workspace/.identity', stats({ file: true })],
      ['/account-workspaces', stats({ directory: true, dev: 2, ino: 2 })],
      ['/account-workspaces/.personal-ai-managed-storage-identity', stats({ file: true })],
      [`/account-workspaces/${ownerId}`, stats({ directory: true, dev: 2, ino: 3 })],
      [`/account-workspaces/${ownerId}/projects`, stats({ directory: true, dev: 2, ino: 4 })],
      [projectPath, stats({ directory: true, dev: 2, ino: 5 })],
      [`${projectPath}/a.txt`, stats({ file: true })],
      [`${projectPath}/z-link`, stats({ symbolicLink: true })]
    ]);
    const fileSystem: WorkspaceFileSystem = {
      lstat: async (filePath) => {
        const entry = entries.get(filePath);
        if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return entry;
      },
      readFile: async (filePath) => filePath === '/workspace/.identity' ? 'host-marker' : 'managed-marker',
      realpath: async (filePath) => filePath,
      readdir: async (directoryPath) => [...entries.keys()]
        .filter((entry) => entry.startsWith(`${directoryPath}/`))
        .map((entry) => entry.slice(directoryPath.length + 1).split('/')[0]!)
        .filter((entry, index, all) => all.indexOf(entry) === index),
      unlink: async (filePath) => { entries.delete(filePath); },
      rmdir: async (directoryPath) => { entries.delete(directoryPath); }
    };
    const adapter = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace', identityFile: '/workspace/.identity', expectedIdentity: 'host-marker',
      managedContainerRoot: '/account-workspaces',
      managedIdentityFile: '/account-workspaces/.personal-ai-managed-storage-identity',
      managedExpectedIdentity: 'managed-marker', fileSystem
    });

    await expect(adapter.removeManagedProjectRoot(ownerId, projectId)).rejects.toBeInstanceOf(WorkspaceStorageUnavailableError);
    expect(entries.has(projectPath)).toBe(true);
    expect(entries.has(`${projectPath}/a.txt`)).toBe(true);
  });

  it('keeps managed storage unavailable when its marker or distinct mount identity cannot be verified', async () => {
    const base = new Map<string, WorkspaceStats>([
      ['/workspace', stats({ directory: true, dev: 1, ino: 1 })],
      ['/workspace/.identity', stats({ file: true })],
      ['/account-workspaces', stats({ directory: true, dev: 1, ino: 1 })],
      ['/account-workspaces/.personal-ai-managed-storage-identity', stats({ file: true })]
    ]);
    const fileSystem = fakeFileSystem(base);
    const adapter = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace', identityFile: '/workspace/.identity', expectedIdentity: 'host-marker',
      managedContainerRoot: '/account-workspaces',
      managedIdentityFile: '/account-workspaces/.personal-ai-managed-storage-identity',
      managedExpectedIdentity: 'managed-marker',
      fileSystem
    });

    await expect(adapter.getManagedSnapshot()).resolves.toMatchObject({ status: 'unavailable' });
    await expect(adapter.createManagedProjectRoot('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'))
      .rejects.toBeInstanceOf(WorkspaceStorageUnavailableError);
    expect(base.has('/workspace/11111111-1111-4111-8111-111111111111')).toBe(false);

    const missingIdentity = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace', identityFile: '/workspace/.identity', expectedIdentity: 'host-marker',
      managedContainerRoot: '/account-workspaces',
      managedIdentityFile: '/account-workspaces/.personal-ai-managed-storage-identity',
      managedExpectedIdentity: 'managed-marker',
      fileSystem: fakeFileSystem(new Map([
        ['/workspace', stats({ directory: true })], ['/workspace/.identity', stats({ file: true })],
        ['/account-workspaces', stats({ directory: true })], ['/account-workspaces/.personal-ai-managed-storage-identity', stats({ file: true })]
      ]))
    });
    await expect(missingIdentity.getManagedSnapshot()).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('rejects managed traversal aliases and reparse-point account namespaces', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const projectId = '22222222-2222-4222-8222-222222222222';
    const entries = new Map<string, WorkspaceStats>([
      ['/workspace', stats({ directory: true, dev: 1, ino: 1 })], ['/workspace/.identity', stats({ file: true })],
      ['/account-workspaces', stats({ directory: true, dev: 2, ino: 2 })],
      ['/account-workspaces/.personal-ai-managed-storage-identity', stats({ file: true })],
      [`/account-workspaces/${ownerId}`, stats({ directory: true, dev: 2, ino: 3, symbolicLink: true })],
      [`/account-workspaces/${ownerId}/projects`, stats({ directory: true, dev: 2, ino: 4 })],
      [`/account-workspaces/${ownerId}/projects/${projectId}`, stats({ directory: true, dev: 2, ino: 5 })]
    ]);
    const baseFileSystem = fakeFileSystem(entries);
    const fileSystem: WorkspaceFileSystem = {
      ...baseFileSystem,
      readFile: async (filePath) => filePath === '/workspace/.identity' ? 'host-marker' : 'managed-marker'
    };
    const adapter = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace', identityFile: '/workspace/.identity', expectedIdentity: 'host-marker',
      managedContainerRoot: '/account-workspaces',
      managedIdentityFile: '/account-workspaces/.personal-ai-managed-storage-identity',
      managedExpectedIdentity: 'managed-marker',
      fileSystem
    });

    await expect(adapter.resolveProjectRoot({ ownerId, projectId, storageKind: 'managed', relativeRoot: '../legacy-project' }))
      .rejects.toBeInstanceOf(WorkspaceStorageUnavailableError);
    await expect(adapter.resolveProjectRoot({ ownerId, projectId, storageKind: 'managed', relativeRoot: `projects/${projectId}` }))
      .rejects.toBeInstanceOf(ProjectRootReparsePointError);
    await expect(adapter.resolveProjectRoot({ ownerId, projectId, storageKind: 'managed', relativeRoot: `projects/${projectId}/..` }))
      .rejects.toBeInstanceOf(WorkspaceStorageUnavailableError);
  });

  it('enumerates only canonical UUID owner and project directories under the verified managed mount', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const projectId = '22222222-2222-4222-8222-222222222222';
    const entries = new Map<string, WorkspaceStats>([
      ['/workspace', stats({ directory: true, dev: 1, ino: 1 })],
      ['/workspace/.identity', stats({ file: true })],
      ['/account-workspaces', stats({ directory: true, dev: 2, ino: 2 })],
      ['/account-workspaces/.personal-ai-managed-storage-identity', stats({ file: true })],
      [`/account-workspaces/${ownerId}`, stats({ directory: true, dev: 2, ino: 3 })],
      [`/account-workspaces/${ownerId}/projects`, stats({ directory: true, dev: 2, ino: 4 })],
      [`/account-workspaces/${ownerId}/projects/${projectId}`, stats({ directory: true, dev: 2, ino: 5 })]
    ]);
    const base = fakeFileSystem(entries);
    const adapter = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace', identityFile: '/workspace/.identity', expectedIdentity: 'host-marker',
      managedContainerRoot: '/account-workspaces',
      managedIdentityFile: '/account-workspaces/.personal-ai-managed-storage-identity',
      managedExpectedIdentity: 'managed-marker',
      fileSystem: { ...base, readFile: async (filePath) => filePath === '/workspace/.identity' ? 'host-marker' : 'managed-marker' }
    });

    await expect(adapter.inspectManagedNamespace()).resolves.toEqual({
      configured: true,
      unattributableEntries: false,
      owners: [{ ownerId, unsafe: false, projectIds: [projectId] }]
    });
  });

  it('marks malformed top-level entries globally untrusted and invalid or reparse child roots unsafe per owner', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const entries = new Map<string, WorkspaceStats>([
      ['/workspace', stats({ directory: true, dev: 1, ino: 1 })],
      ['/workspace/.identity', stats({ file: true })],
      ['/account-workspaces', stats({ directory: true, dev: 2, ino: 2 })],
      ['/account-workspaces/.personal-ai-managed-storage-identity', stats({ file: true })],
      ['/account-workspaces/unowned-folder', stats({ directory: true })],
      [`/account-workspaces/${ownerId}`, stats({ directory: true, dev: 2, ino: 3 })],
      [`/account-workspaces/${ownerId}/projects`, stats({ directory: true, dev: 2, ino: 4 })],
      [`/account-workspaces/${ownerId}/projects/not-a-project-id`, stats({ directory: true })],
      [`/account-workspaces/${ownerId}/projects/33333333-3333-4333-8333-333333333333`, stats({ directory: true, symbolicLink: true })]
    ]);
    const base = fakeFileSystem(entries);
    const adapter = new WorkspaceBoundaryAdapter({
      containerRoot: '/workspace', identityFile: '/workspace/.identity', expectedIdentity: 'host-marker',
      managedContainerRoot: '/account-workspaces',
      managedIdentityFile: '/account-workspaces/.personal-ai-managed-storage-identity',
      managedExpectedIdentity: 'managed-marker',
      fileSystem: { ...base, readFile: async (filePath) => filePath === '/workspace/.identity' ? 'host-marker' : 'managed-marker' }
    });

    await expect(adapter.inspectManagedNamespace()).resolves.toEqual({
      configured: true,
      unattributableEntries: true,
      owners: [{ ownerId, unsafe: true, projectIds: [] }]
    });
  });
});
