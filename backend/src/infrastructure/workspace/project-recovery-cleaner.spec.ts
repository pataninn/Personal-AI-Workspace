import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProjectRecoveryCleaner } from '@/infrastructure/workspace/project-recovery-cleaner';

const RUN_ID = '11111111-1111-4111-8111-111111111111';

describe('ProjectRecoveryCleaner', () => {
  let root: string;
  let recovery: string;
  let original: string;
  let cleaner: ProjectRecoveryCleaner;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-removal-'));
    recovery = path.join(root, 'recovery');
    original = path.join(recovery, `run-${RUN_ID}`);
    await fs.mkdir(original, { recursive: true });
    await fs.writeFile(path.join(original, 'before.txt.bak'), 'private history');
    await fs.mkdir(path.join(root, 'project'));
    await fs.writeFile(path.join(root, 'project', 'source.txt'), 'project source');
    cleaner = new ProjectRecoveryCleaner(recovery);
  });

  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('restores history after quarantine without touching authoritative project files', async () => {
    const quarantine = await cleaner.quarantine([RUN_ID]);
    await expect(fs.stat(original)).rejects.toMatchObject({ code: 'ENOENT' });
    await quarantine.restore();
    await expect(fs.readFile(path.join(original, 'before.txt.bak'), 'utf8')).resolves.toBe('private history');
    await expect(fs.readFile(path.join(root, 'project', 'source.txt'), 'utf8')).resolves.toBe('project source');
  });

  it('purges only quarantined run directories and supports startup retry', async () => {
    await cleaner.quarantine([RUN_ID]);
    const otherRun = '22222222-2222-4222-8222-222222222222';
    await fs.mkdir(path.join(recovery, `run-${otherRun}`));
    await fs.writeFile(path.join(recovery, `run-${otherRun}`, 'keep.bak'), 'another run');
    await cleaner.purge([RUN_ID]);
    await cleaner.purge([RUN_ID]);
    await expect(fs.readdir(recovery)).resolves.toEqual([`run-${otherRun}`]);
    await expect(fs.readFile(path.join(root, 'project', 'source.txt'), 'utf8')).resolves.toBe('project source');
  });

  it('purges a named original recovery directory after a crash before quarantine', async () => {
    await cleaner.purge([RUN_ID]);
    await expect(fs.stat(original)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed run IDs before moving any backups', async () => {
    await expect(cleaner.quarantine([RUN_ID, '../project'])).rejects.toMatchObject({ code: 'PROJECT_RECOVERY_CLEANUP_FAILED' });
    await expect(fs.readFile(path.join(original, 'before.txt.bak'), 'utf8')).resolves.toBe('private history');
  });

  it('rejects linked backup directories before changing their targets', async () => {
    await fs.symlink(path.join(root, 'project'), path.join(original, 'outside'), 'junction');
    await expect(cleaner.quarantine([RUN_ID])).rejects.toMatchObject({ code: 'PROJECT_RECOVERY_CLEANUP_FAILED' });
    await expect(fs.readFile(path.join(root, 'project', 'source.txt'), 'utf8')).resolves.toBe('project source');
  });
});
