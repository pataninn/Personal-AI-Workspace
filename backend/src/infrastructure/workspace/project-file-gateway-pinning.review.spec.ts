import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import { ProjectFileGateway } from '@/infrastructure/workspace/project-file-gateway';

const PARENT = '/review-root/project/tools';
const PINNED = '/proc/self/fd/77/script.sh';
const SCOPE = { projectId: 'project', relativeRoot: 'project' };
const ORIGINAL = Buffer.from('original');
const HASH = createHash('sha256').update(ORIGINAL).digest('hex');

function fixture(pinnedParent = PARENT) {
  const parentClose = jest.fn();
  const chmod = jest.fn();
  const writeFile = jest.fn();
  const writeClose = jest.fn();
  const fileStats = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: ORIGINAL.length, mode: 0o755, ino: 5, dev: 1 } as Stats;
  const directoryStats = { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } as Stats;
  jest.spyOn(fs, 'realpath').mockImplementation(async (value) => String(value) === '/proc/self/fd/77' ? pinnedParent : String(value));
  jest.spyOn(fs, 'lstat').mockImplementation(async (value) => String(value).endsWith('/script.sh') ? fileStats : directoryStats);
  jest.spyOn(fs, 'stat').mockResolvedValue(fileStats);
  jest.spyOn(fs, 'rename').mockResolvedValue(undefined);
  jest.spyOn(fs, 'unlink').mockResolvedValue(undefined);
  const open = jest.spyOn(fs, 'open').mockImplementation(async (value, flags) => {
    if (String(value) === PARENT) return { fd: 77, close: parentClose } as unknown as FileHandle;
    if (flags === 'wx') return { stat: async () => fileStats, chmod, writeFile, sync: async () => undefined, close: writeClose } as unknown as FileHandle;
    let position = 0;
    return { stat: async () => fileStats, close: async () => undefined,
      read: async (buffer: Buffer, offset: number, length: number) => {
        const count = Math.min(length, ORIGINAL.length - position);
        ORIGINAL.copy(buffer, offset, position, position + count);
        position += count;
        return { bytesRead: count, buffer };
      }
    } as unknown as FileHandle;
  });
  const gateway = new ProjectFileGateway({ containerRoot: '/review-root', workspaceBoundary: {
    assertReady: async () => undefined, getSnapshot: async () => ({ status: 'ready' }), validateProjectRoot: async (value) => value
  } });
  return { gateway, parentClose, chmod, writeFile, open, writeClose };
}

describe('Linux manual file directory pinning review', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('reads through the pinned directory descriptor and closes it after the operation', async () => {
    const { gateway, open, parentClose } = fixture();
    await expect(gateway.download(SCOPE, 'tools/script.sh')).resolves.toEqual({ bytes: ORIGINAL, hash: HASH });
    expect(open.mock.calls.map(([target]) => String(target))).toEqual([PARENT, PINNED]);
    expect(parentClose).toHaveBeenCalledTimes(1);
  });

  it('rejects an opened parent that resolves outside the project before file access', async () => {
    const { gateway, open, parentClose } = fixture('/external/tools');
    await expect(gateway.download(SCOPE, 'tools/script.sh')).rejects.toMatchObject({ code: 'WORKSPACE_PATH_FORBIDDEN' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(parentClose).toHaveBeenCalledTimes(1);
  });

  it('preserves existing executable mode and uses pinned paths during an edit', async () => {
    const { gateway, open, chmod, writeFile, writeClose, parentClose } = fixture();
    const updated = Buffer.from('updated');
    await gateway.write(SCOPE, { path: 'tools/script.sh', bytes: updated, expectedHash: HASH });
    expect(open).toHaveBeenCalledWith(PINNED, 'wx', 0o755);
    expect(chmod).toHaveBeenCalledWith(0o755);
    expect(writeFile).toHaveBeenCalledWith(updated);
    expect(fs.rename).toHaveBeenCalledWith(PINNED, expect.stringMatching(/^\/proc\/self\/fd\/77\/\.personal-ai-file-/u));
    expect(writeClose).toHaveBeenCalledTimes(1);
    expect(parentClose).toHaveBeenCalledTimes(1);
  });
});
