import { WorkspacePathForbiddenError } from '@/modules/files/domain/workspace-errors';
import {
  resolveWorkspaceEntry,
  type WorkspaceScopePaths
} from '@/infrastructure/workspace/workspace-gateway-paths';
import type {
  WorkspaceGatewayFileSystem,
  WorkspaceGatewayStats
} from '@/infrastructure/workspace/workspace-gateway-fs';
import { WorkspaceOperationContext } from '@/infrastructure/workspace/workspace-operation';

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
});
