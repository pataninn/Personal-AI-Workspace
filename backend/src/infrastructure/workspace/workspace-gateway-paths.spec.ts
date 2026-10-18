import path from 'node:path';

import { WorkspacePathForbiddenError } from '@/modules/files/domain/workspace-errors';
import {
  isContained,
  resolveWorkspaceScope,
  resolveWorkspaceEntry,
  type WorkspaceScopePaths
} from '@/infrastructure/workspace/workspace-gateway-paths';
import type {
  WorkspaceGatewayFileSystem,
  WorkspaceGatewayStats
} from '@/infrastructure/workspace/workspace-gateway-fs';
import { WorkspaceOperationContext } from '@/infrastructure/workspace/workspace-operation';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';

function stats(options: { readonly directory?: boolean; readonly file?: boolean }): WorkspaceGatewayStats {
  return {
    isDirectory: () => options.directory === true,
    isFile: () => options.file === true,
    isSymbolicLink: () => false
  };
}

function missing(): Error {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

describe('resolveWorkspaceEntry', () => {
  it.each([
    ['sibling-prefix', 'C:\\workspace-evil\\secret.txt'],
    ['parent escape', 'C:\\outside\\secret.txt'],
    ['cross-drive target', 'D:\\workspace\\secret.txt']
  ])('rejects a Windows %s outside the canonical root', (_case, target) => {
    expect(isContained('C:\\workspace', target, true)).toBe(false);
  });

  it('compares native Windows paths case-insensitively', () => {
    expect(isContained('C:\\workspace', 'c:\\WORKSPACE\\secret.txt', true)).toBe(true);
  });

  it('preserves POSIX case sensitivity when checking containment', () => {
    expect(isContained('/workspace', '/WORKSPACE/secret.txt', true)).toBe(false);
  });

  it('uses native Windows paths for root-project containment and file lookup', async () => {
    const root = 'C:\\workspace';
    const fileSystem: WorkspaceGatewayFileSystem = {
      lstat: async (filePath) => {
        const relative = path.win32.relative(root, filePath);
        if (relative === '') return stats({ directory: true });
        if (relative.toLocaleLowerCase('en-US') === 'readme.md') return stats({ file: true });
        return Promise.reject(missing());
      },
      realpath: async (filePath) => filePath,
      readDirectory: async () => [],
      openRead: async () => ({ read: async () => 0, close: async () => undefined })
    };
    const boundary: IWorkspaceBoundary = {
      assertReady: async () => undefined,
      getSnapshot: async () => ({ status: 'ready' }),
      validateProjectRoot: async (relativeRoot) => relativeRoot === '.' ? '.' : Promise.reject(new Error('unexpected root'))
    };
    const context = new WorkspaceOperationContext(undefined, 5000);
    const scopePaths = await resolveWorkspaceScope(boundary, fileSystem, root, {
      ownerId: 'owner-root',
      projectId: 'project-root',
      storageKind: 'legacy',
      relativeRoot: '.'
    }, context);

    await expect(resolveWorkspaceEntry(fileSystem, scopePaths, 'README.md', context)).resolves.toMatchObject({ path: 'README.md' });
  });

  it('normalizes nested Windows host-relative paths to POSIX API paths', async () => {
    const root = 'C:\\workspace';
    const projectRoot = `${root}\\apps\\demo`;
    const nestedDirectory = `${projectRoot}\\src`;
    const nestedFile = `${nestedDirectory}\\index.ts`;
    const fileSystem: WorkspaceGatewayFileSystem = {
      lstat: async (filePath) => {
        if (filePath === nestedDirectory) return stats({ directory: true });
        if (filePath === nestedFile) return stats({ file: true });
        return Promise.reject(missing());
      },
      realpath: async (filePath) => filePath,
      readDirectory: async () => [],
      openRead: async () => ({ read: async () => 0, close: async () => undefined })
    };
    const boundary: IWorkspaceBoundary = {
      assertReady: async () => undefined,
      getSnapshot: async () => ({ status: 'ready' }),
      validateProjectRoot: async (relativeRoot) => relativeRoot === 'apps/demo' ? 'apps/demo' : Promise.reject(new Error('unexpected root'))
    };
    const context = new WorkspaceOperationContext(undefined, 5000);
    const scopePaths = await resolveWorkspaceScope(boundary, fileSystem, root, {
      ownerId: 'owner-nested',
      projectId: 'nested-project',
      storageKind: 'legacy',
      relativeRoot: 'apps/demo'
    }, context);

    await expect(resolveWorkspaceEntry(fileSystem, scopePaths, 'src/index.ts', context)).resolves.toMatchObject({ path: 'src/index.ts' });
  });

  it('revalidates protected segments after a realpath alias is canonicalized', async () => {
    const aliasPath = '/workspace/apps/ALIAS~1/config.txt';
    const canonicalPath = '/workspace/apps/.git/config';
    const entries = new Map<string, WorkspaceGatewayStats>([
      ['/workspace/apps', stats({ directory: true })],
      ['/workspace/apps/ALIAS~1', stats({ directory: true })],
      [aliasPath, stats({ file: true })],
      [canonicalPath, stats({ file: true })]
    ]);
    const fileSystem: WorkspaceGatewayFileSystem = {
      lstat: async (filePath) => entries.get(filePath) ?? Promise.reject(missing()),
      realpath: async (filePath) => filePath === aliasPath ? canonicalPath : filePath,
      readDirectory: async () => [],
      openRead: async () => ({ read: async () => 0, close: async () => undefined })
    };
    const scopePaths: WorkspaceScopePaths = {
      canonicalRoot: '/workspace',
      canonicalProjectRoot: '/workspace/apps'
    };

    await expect(resolveWorkspaceEntry(
      fileSystem,
      scopePaths,
      'ALIAS~1/config.txt',
      new WorkspaceOperationContext(undefined, 5000)
    )).rejects.toBeInstanceOf(WorkspacePathForbiddenError);
  });

  it('revalidates protected Windows segments after a realpath alias is canonicalized', async () => {
    const root = 'C:\\workspace';
    const aliasPath = `${root}\\ALIAS~1\\config.txt`;
    const canonicalPath = `${root}\\.git\\config`;
    const entries = new Map<string, WorkspaceGatewayStats>([
      [`${root}\\ALIAS~1`, stats({ directory: true })],
      [aliasPath, stats({ file: true })],
      [canonicalPath, stats({ file: true })]
    ]);
    const fileSystem: WorkspaceGatewayFileSystem = {
      lstat: async (filePath) => entries.get(filePath) ?? Promise.reject(missing()),
      realpath: async (filePath) => filePath === aliasPath ? canonicalPath : filePath,
      readDirectory: async () => [],
      openRead: async () => ({ read: async () => 0, close: async () => undefined })
    };

    await expect(resolveWorkspaceEntry(
      fileSystem,
      { canonicalRoot: root, canonicalProjectRoot: root },
      'ALIAS~1/config.txt',
      new WorkspaceOperationContext(undefined, 5000)
    )).rejects.toBeInstanceOf(WorkspacePathForbiddenError);
  });

  it('allows a validated root project while keeping protected paths inaccessible', async () => {
    const fileSystem: WorkspaceGatewayFileSystem = {
      lstat: async () => stats({ directory: true }),
      realpath: async (filePath) => filePath,
      readDirectory: async () => [],
      openRead: async () => ({ read: async () => 0, close: async () => undefined })
    };
    const boundary: IWorkspaceBoundary = {
      assertReady: async () => undefined,
      getSnapshot: async () => ({ status: 'ready' }),
      validateProjectRoot: async (relativeRoot) => relativeRoot === '.' ? '.' : Promise.reject(new Error('unexpected root'))
    };
    const context = new WorkspaceOperationContext(undefined, 5000);
    const scopePaths = await resolveWorkspaceScope(boundary, fileSystem, '/workspace', {
      ownerId: 'owner-1',
      projectId: 'project-1',
      storageKind: 'legacy',
      relativeRoot: '.'
    }, context);

    expect(scopePaths).toEqual({ canonicalRoot: '/workspace', canonicalProjectRoot: '/workspace' });
    await expect(resolveWorkspaceEntry(fileSystem, scopePaths, 'README.md', context)).resolves.toMatchObject({ path: 'README.md' });
    await expect(resolveWorkspaceEntry(fileSystem, scopePaths, '.git/config', context)).rejects.toBeInstanceOf(WorkspacePathForbiddenError);
    await expect(resolveWorkspaceEntry(fileSystem, scopePaths, '.env', context)).rejects.toBeInstanceOf(WorkspacePathForbiddenError);
  });
});
