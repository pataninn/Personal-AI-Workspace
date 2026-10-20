import { promises as nodeFs } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectFileGateway } from '@/infrastructure/workspace/project-file-gateway';
import type { ExportCaptureTestFileSystem } from '@/infrastructure/workspace/project-file-export-capture';

describe('manual project files', () => {
  let directory: string;
  let gateway: ProjectFileGateway;
  const scope = { ownerId: 'owner', projectId: 'project', storageKind: 'legacy' as const, relativeRoot: 'project' };

  beforeEach(async () => {
    directory = (await mkdtemp(path.join(tmpdir(), 'pai-file-tools-'))).replaceAll('\\', '/');
    await mkdir(`${directory}/project`);
    gateway = new ProjectFileGateway({ containerRoot: directory, workspaceBoundary: {
      getSnapshot: async () => ({ status: 'ready' }), assertReady: async () => undefined,
      validateProjectRoot: async (value) => value
    } });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('round trips binary uploads and refuses duplicate names', async () => {
    const bytes = Buffer.from([0, 255, 1, 128]);
    const created = await gateway.write(scope, { path: 'image.bin', bytes, expectedHash: null });
    const downloaded = await gateway.download(scope, 'image.bin');
    expect(downloaded.bytes).toEqual(bytes);
    expect(downloaded.hash).toEqual(created.hash);
    await expect(gateway.write(scope, { path: 'image.bin', bytes: Buffer.from('other'), expectedHash: null })).rejects.toMatchObject({ code: 'FILE_CONFLICT' });
    expect(await readFile(`${directory}/project/image.bin`)).toEqual(bytes);
  });

  it('detects stale edits and deletes without changing newer contents', async () => {
    const created = await gateway.write(scope, { path: 'notes.md', bytes: Buffer.from('original'), expectedHash: null });
    await writeFile(`${directory}/project/notes.md`, 'external edit');
    await expect(gateway.write(scope, { path: 'notes.md', bytes: Buffer.from('replacement'), expectedHash: created.hash })).rejects.toMatchObject({ code: 'FILE_CONFLICT' });
    await expect(gateway.remove(scope, { path: 'notes.md', expectedHash: created.hash })).rejects.toMatchObject({ code: 'FILE_CONFLICT' });
    expect(await readFile(`${directory}/project/notes.md`, 'utf8')).toBe('external edit');
    const fresh = await gateway.download(scope, 'notes.md');
    await gateway.remove(scope, { path: 'notes.md', expectedHash: fresh.hash });
    await expect(readFile(`${directory}/project/notes.md`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal, project root mutation and protected credentials', async () => {
    for (const target of ['../outside.txt', '.env', '.git/config', 'keys/key.txt', 'passwords.txt', '.']) {
      await expect(gateway.write(scope, { path: target, bytes: Buffer.from('content'), expectedHash: null })).rejects.toThrow();
    }
  });

  it('captures every permitted nested text and binary file while omitting protected paths', async () => {
    await mkdir(`${directory}/project/src/nested`, { recursive: true });
    await mkdir(`${directory}/project/.personal-ai/recovery`, { recursive: true });
    const binary = Buffer.from([0, 255, 1, 128]);
    await writeFile(`${directory}/project/src/nested/main.ts`, 'export const ready = true;');
    await writeFile(`${directory}/project/src/image.bin`, binary);
    await writeFile(`${directory}/project/.env`, 'API_KEY=hidden');
    await writeFile(`${directory}/project/credentials.json`, '{"token":"hidden"}');
    await writeFile(`${directory}/project/.personal-ai/recovery/session.json`, '{}');

    const files = await gatewayForCapture().captureForExport(scope, captureLimits());

    expect(files.map((file) => file.path).sort()).toEqual(['src/image.bin', 'src/nested/main.ts']);
    expect(Buffer.from(files.find((file) => file.path === 'src/image.bin')?.content ?? '', 'base64')).toEqual(binary);
    expect(Buffer.from(files.find((file) => file.path === 'src/nested/main.ts')?.content ?? '', 'base64').toString('utf8'))
      .toBe('export const ready = true;');
  });

  it('returns the contract unsafe-content error for a recognized credential in file bytes', async () => {
    await writeFile(`${directory}/project/notes.txt`, 'api_key=recognized-secret-value');

    await expect(gatewayForCapture().captureForExport(scope, captureLimits()))
      .rejects.toMatchObject({ code: 'EXPORT_CONTENT_UNSAFE', statusCode: 422 });
  });

  it('rejects traversal and directory links instead of following them', async () => {
    await mkdir(`${directory}/outside`, { recursive: true });
    await writeFile(`${directory}/outside/escape.txt`, 'outside');
    await expect(gatewayForCapture().captureForExport({ ...scope, relativeRoot: '../outside' }, captureLimits())).rejects.toThrow();

    try {
      await symlink(`${directory}/outside`, `${directory}/project/linked`, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error: unknown) {
      if (process.platform !== 'win32' || !hasWindowsLinkPermissionError(error)) throw error;
      return;
    }
    await expect(gatewayForCapture().captureForExport(scope, captureLimits()))
      .rejects.toMatchObject({ code: 'EXPORT_FAILED', statusCode: 500 });
  });

  it('fails closed when a permitted file changes between enumeration and open', async () => {
    const target = `${directory}/project/changing.txt`;
    await writeFile(target, 'before');
    const base = captureFileSystem();
    const changedFileSystem: ExportCaptureTestFileSystem = {
      ...base,
      openRead: async (filePath) => {
        if (filePath.endsWith('changing.txt')) await writeFile(filePath, 'changed after enumeration');
        return base.openRead(filePath);
      }
    };

    await expect(gatewayForCapture(changedFileSystem).captureForExport(scope, captureLimits()))
      .rejects.toMatchObject({ code: 'EXPORT_FAILED', statusCode: 500 });
  });

  it('fails closed when directory enumeration is incomplete', async () => {
    await mkdir(`${directory}/project/nested`, { recursive: true });
    await writeFile(`${directory}/project/nested/hidden.txt`, 'content');
    const base = captureFileSystem();
    const incompleteFileSystem: ExportCaptureTestFileSystem = {
      ...base,
      readDirectory: async (directoryPath) => {
        if (directoryPath.endsWith('nested')) throw Object.assign(new Error('unreadable directory'), { code: 'EIO' });
        return base.readDirectory(directoryPath);
      }
    };

    await expect(gatewayForCapture(incompleteFileSystem).captureForExport(scope, captureLimits()))
      .rejects.toMatchObject({ code: 'EIO' });
  });

  it('enforces the direct capture deadline and file-count bound', async () => {
    await writeFile(`${directory}/project/notes.txt`, 'content');
    const captureGateway = gatewayForCapture();

    await expect(captureGateway.captureForExport(scope, { ...captureLimits(), deadlineAt: Date.now() - 1 }))
      .rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE', statusCode: 413 });
    await expect(captureGateway.captureForExport(scope, { ...captureLimits(), maxFiles: 0 }))
      .rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE', statusCode: 413 });
  });

  function gatewayForCapture(fileSystem = captureFileSystem()): ProjectFileGateway {
    return new ProjectFileGateway({
      containerRoot: directory,
      workspaceBoundary: {
        getSnapshot: async () => ({ status: 'ready' }), assertReady: async () => undefined,
        validateProjectRoot: async (value) => value
      },
      exportCaptureFileSystemForTests: fileSystem
    });
  }

  function captureFileSystem(): ExportCaptureTestFileSystem {
    return {
      lstat: async (filePath) => nodeFs.lstat(filePath, { bigint: true }),
      realpath: async (filePath) => nodeFs.realpath(filePath),
      readDirectory: async (directoryPath) => nodeFs.readdir(directoryPath),
      openRead: async (filePath) => {
        const handle = await nodeFs.open(filePath, 'r');
        return {
          stat: async () => handle.stat({ bigint: true }),
          read: async (buffer, offset, length, position) => (await handle.read(buffer, offset, length, position)).bytesRead,
          close: () => handle.close()
        };
      }
    };
  }

  function captureLimits(): { readonly maxFiles: number; readonly maxTotalBytes: number; readonly deadlineAt: number } {
    return { maxFiles: 100, maxTotalBytes: 1024 * 1024, deadlineAt: Date.now() + 5000 };
  }
});

function hasWindowsLinkPermissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES');
}
