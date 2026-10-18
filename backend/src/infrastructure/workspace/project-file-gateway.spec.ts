import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectFileGateway } from '@/infrastructure/workspace/project-file-gateway';

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
});
