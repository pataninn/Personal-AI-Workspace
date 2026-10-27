import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  recoveryReferenceIdentity,
  StorageQuotaRootScanner,
  StorageRootScanError,
  type StorageScanFileSystem,
  type StorageScanStats,
  type TrustedStorageRoot
} from '@/infrastructure/workspace/storage-quota-reconciliation';

describe('StorageQuotaRootScanner', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'storage-quota-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('measures trusted regular files by exact size and hashes their contents', async () => {
    await writeFile(path.join(directory, 'notes.md'), 'café', 'utf8');
    const references = await new StorageQuotaRootScanner().scan([trustedRoot(directory)]);

    expect(references).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'project_file', copyKey: 'notes.md', bytes: 5n, projectId: 'project-1', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
    ]));
  });

  it('fails closed on a missing root instead of interpreting it as zero bytes', async () => {
    await expect(new StorageQuotaRootScanner().scan([trustedRoot(path.join(directory, 'absent'))])).rejects.toBeInstanceOf(StorageRootScanError);
  });

  it('rejects symlinks and reparse points without descending into them', async () => {
    const fileSystem: StorageScanFileSystem = {
      lstat: jest.fn(async (filePath) => filePath.endsWith('link')
        ? fakeStats({ symlink: true })
        : fakeStats({ directory: true })),
      readdir: jest.fn(async () => [{ name: 'link' }]),
      hashFile: jest.fn(async () => '0'.repeat(64))
    };
    const scanner = new StorageQuotaRootScanner(fileSystem);

    await expect(scanner.scan([trustedRoot(directory)])).rejects.toBeInstanceOf(StorageRootScanError);
    expect(fileSystem.readdir).toHaveBeenCalledTimes(1);
  });

  it('keeps one logical recovery identity while its directory is quarantined', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const original = path.join(directory, `run-${runId}`, 'proposal', 'copy.bak');
    await mkdir(path.dirname(original), { recursive: true });
    await writeFile(original, 'backup bytes');
    const root = recoveryRoot(directory);
    const scanner = new StorageQuotaRootScanner();
    const before = await scanner.scan([root]);
    await rename(path.join(directory, `run-${runId}`), path.join(directory, `.removed-run-${runId}`));
    const after = await scanner.scan([root]);

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before[0]);
    expect(after[0]).toMatchObject({
      kind: 'recovery_file', ownerId: 'owner-1', projectId: 'project-1',
      resourceKey: runId, rootKey: 'recovery-v1',
      copyKey: `run-${runId}/proposal/copy.bak`, relativeKey: `run-${runId}/proposal/copy.bak`, bytes: 12n
    });
  });

  it('fails closed on recovery files without a persisted run identity', async () => {
    await mkdir(path.join(directory, 'orphan'), { recursive: true });
    await writeFile(path.join(directory, 'orphan', 'copy.bak'), 'unknown owner');

    await expect(new StorageQuotaRootScanner().scan([recoveryRoot(directory)])).rejects.toBeInstanceOf(StorageRootScanError);
  });
});

function trustedRoot(absolutePath: string): TrustedStorageRoot {
  return {
    ownerId: 'owner-1', projectId: 'project-1', rootKey: 'managed:project-1', absolutePath,
    classifyFile: () => 'project_file'
  };
}

function recoveryRoot(absolutePath: string): TrustedStorageRoot {
  return {
    ownerId: 'owner-1', projectId: 'project-1', rootKey: 'recovery-v1', absolutePath,
    classifyFile: () => 'recovery_file',
    referenceForFile: (physicalRelativeKey) => recoveryReferenceIdentity(physicalRelativeKey, 'project-1')
  };
}

function fakeStats(options: { directory?: boolean; file?: boolean; symlink?: boolean; reparse?: boolean } = {}): StorageScanStats {
  return {
    size: 0,
    isDirectory: () => options.directory === true,
    isFile: () => options.file === true,
    isSymbolicLink: () => options.symlink === true,
    isReparsePoint: () => options.reparse === true
  };
}
