import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getWorkspaceTree, flattenWorkspaceFiles, normalizeWorkspaceTree } from '@/entities/workspace';

const { getJsonMock } = vi.hoisted(() => ({ getJsonMock: vi.fn() }));

vi.mock('@/shared/api', () => ({ getJson: getJsonMock }));

describe('workspace file candidates', () => {
  beforeEach(() => {
    getJsonMock.mockReset();
  });

  it('loads the bounded project tree and keeps only safe relative file paths', async () => {
    getJsonMock.mockResolvedValue({
      directory: '',
      depth: 4,
      truncated: false,
      entries: [
        { path: 'src', name: 'src', type: 'directory', children: [
          { path: 'src/app.ts', name: 'app.ts', type: 'file', sizeBytes: 42 },
          { path: '../secret.env', name: 'secret.env', type: 'file', sizeBytes: 10 }
        ] },
        { path: '/absolute.txt', name: 'absolute.txt', type: 'file', sizeBytes: 10 }
      ]
    });

    const tree = await getWorkspaceTree('project-id');

    expect(getJsonMock).toHaveBeenCalledWith('/api/v1/projects/project-id/files/tree?depth=4');
    expect(flattenWorkspaceFiles(tree)).toEqual([{ path: 'src/app.ts', sizeBytes: 42 }]);
  });

  it('normalizes malformed nodes without exposing host paths or control characters', () => {
    const tree = normalizeWorkspaceTree({
      directory: 'C:\\workspace',
      depth: 3,
      truncated: true,
      entries: [
        { path: 'notes/readme.md', name: 'readme.md', type: 'file', sizeBytes: 12 },
        { path: 'bad\u0000name.txt', name: 'bad', type: 'file', sizeBytes: 2 },
        { path: 'src', name: 'src', type: 'directory', children: [{ path: 'src/nested.ts', name: 'nested.ts', type: 'file' }] }
      ]
    });

    expect(tree.directory).toBe('');
    expect(flattenWorkspaceFiles(tree)).toEqual([
      { path: 'notes/readme.md', sizeBytes: 12 },
      { path: 'src/nested.ts', sizeBytes: 0 }
    ]);
  });
});
