import { constants as fsConstants, promises as nodeFs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { StorageResourceReference } from '@/modules/storage-quotas/domain/storage-quota-types';

export interface StorageScanStats {
  readonly size: number | bigint;
  readonly dev?: number | bigint;
  readonly ino?: number | bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isReparsePoint?(): boolean;
}

export interface StorageScanDirectoryEntry {
  readonly name: string;
}

export interface StorageScanFileSystem {
  lstat(filePath: string): Promise<StorageScanStats>;
  readdir(directoryPath: string): Promise<readonly StorageScanDirectoryEntry[]>;
  hashFile(filePath: string, expectedStats: StorageScanStats): Promise<string>;
}

export interface TrustedStorageRoot {
  readonly ownerId: string;
  readonly projectId: string | null;
  /** Opaque persisted mapping key, never a host path. */
  readonly rootKey: string;
  /** Resolved only from persisted owner/project mappings. */
  readonly absolutePath: string;
  /** Return null for trusted non-content metadata paths. */
  classifyFile(relativeKey: string): 'project_file' | 'recovery_file' | 'retained_root' | null;
  /** Supplies persisted run/copy identity for roots whose physical path is not their logical key. */
  referenceForFile?(physicalRelativeKey: string): StorageScanReferenceIdentity | null;
}

export interface StorageScanReferenceIdentity {
  readonly kind: 'project_file' | 'recovery_file' | 'retained_root';
  readonly resourceKey: string;
  readonly copyKey: string;
  readonly projectId: string | null;
  readonly rootKey: string;
  readonly relativeKey: string;
}

const MAX_RELATIVE_KEY_LENGTH = 2048;

export class StorageRootScanError extends Error {
  public constructor() {
    super('A trusted storage root could not be scanned safely.');
    this.name = 'StorageRootScanError';
  }
}

const defaultFileSystem: StorageScanFileSystem = {
  lstat: (filePath) => nodeFs.lstat(filePath),
  readdir: async (directoryPath) => nodeFs.readdir(directoryPath, { withFileTypes: true }),
  hashFile: hashRegularFile
};

/** Walks only resolver-supplied roots and rejects symlinks, reparse points, and special files. */
export class StorageQuotaRootScanner {
  private readonly fileSystem: StorageScanFileSystem;

  public constructor(fileSystem: StorageScanFileSystem = defaultFileSystem) {
    this.fileSystem = fileSystem;
  }

  public async scan(roots: readonly TrustedStorageRoot[]): Promise<readonly StorageResourceReference[]> {
    const references: StorageResourceReference[] = [];
    for (const root of roots) {
      try {
        const rootStats = await this.fileSystem.lstat(root.absolutePath);
        if (!rootStats.isDirectory() || isReparsePoint(rootStats)) throw new StorageRootScanError();
        await this.walk(root, root.absolutePath, '', references);
      } catch {
        throw new StorageRootScanError();
      }
    }
    return references;
  }

  private async walk(
    root: TrustedStorageRoot,
    directoryPath: string,
    relativeDirectory: string,
    references: StorageResourceReference[]
  ): Promise<void> {
    const entries = await this.fileSystem.readdir(directoryPath);
    for (const entry of entries) {
      if (!entry.name || entry.name === '.' || entry.name === '..' || entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('\u0000')) {
        throw new StorageRootScanError();
      }
      const relativeKey = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (relativeKey.length > MAX_RELATIVE_KEY_LENGTH) throw new StorageRootScanError();
      const filePath = path.join(directoryPath, entry.name);
      const stats = await this.fileSystem.lstat(filePath);
      if (isReparsePoint(stats)) throw new StorageRootScanError();
      if (stats.isDirectory()) {
        await this.walk(root, filePath, relativeKey, references);
        continue;
      }
      if (!stats.isFile()) throw new StorageRootScanError();
      const kind = root.classifyFile(relativeKey);
      if (kind === null) continue;
      const identity = root.referenceForFile?.(relativeKey);
      if (root.referenceForFile && !identity) throw new StorageRootScanError();
      if (kind === 'recovery_file' && (!identity || root.rootKey !== 'recovery-v1')) throw new StorageRootScanError();
      const numericBytes = typeof stats.size === 'bigint' ? stats.size : safeFileBytes(stats.size);
      if (numericBytes < 0n) throw new StorageRootScanError();
      const sha256 = await this.fileSystem.hashFile(filePath, stats);
      if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new StorageRootScanError();
      if (identity && (identity.kind !== kind || !isValidReferenceIdentity(root, identity))) {
        throw new StorageRootScanError();
      }
      references.push({
        ownerId: root.ownerId,
        kind: identity?.kind ?? kind,
        resourceKey: identity?.resourceKey ?? root.rootKey,
        copyKey: identity?.copyKey ?? relativeKey,
        bytes: numericBytes,
        projectId: identity ? identity.projectId : (kind === 'retained_root' ? null : root.projectId),
        rootKey: identity?.rootKey ?? root.rootKey,
        relativeKey: identity?.relativeKey ?? relativeKey,
        sha256
      });
    }
  }
}

/** Maps both live and quarantined recovery paths onto one durable run/copy identity. */
export function recoveryReferenceIdentity(
  physicalRelativeKey: string,
  projectId: string | null
): StorageScanReferenceIdentity | null {
  const match = /^(?:run-|\.removed-run-)([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(.+)$/iu.exec(physicalRelativeKey);
  const runId = match?.[1]?.toLowerCase();
  const suffix = match?.[2];
  if (!runId || !suffix || projectId === null || suffix.length > MAX_RELATIVE_KEY_LENGTH) return null;
  const relativeKey = `run-${runId}/${suffix}`;
  if (!isSafeRelativeKey(relativeKey)) return null;
  return {
    kind: 'recovery_file',
    resourceKey: runId,
    copyKey: relativeKey,
    projectId,
    rootKey: 'recovery-v1',
    relativeKey
  };
}

function isValidReferenceIdentity(root: TrustedStorageRoot, identity: StorageScanReferenceIdentity): boolean {
  if (!identity.resourceKey || !identity.copyKey || identity.projectId !== root.projectId || identity.rootKey !== root.rootKey
    || !isSafeRelativeKey(identity.relativeKey) || identity.copyKey !== identity.relativeKey) return false;
  if (identity.kind !== 'recovery_file') return true;
  const expected = recoveryReferenceIdentity(identity.relativeKey, identity.projectId);
  return root.rootKey === 'recovery-v1' && expected?.resourceKey === identity.resourceKey
    && expected.relativeKey === identity.relativeKey;
}

function isSafeRelativeKey(relativeKey: string): boolean {
  return relativeKey.length > 0 && relativeKey.length <= MAX_RELATIVE_KEY_LENGTH
    && !relativeKey.startsWith('/') && !relativeKey.includes('\\') && !relativeKey.includes('\u0000')
    && relativeKey.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isReparsePoint(stats: StorageScanStats): boolean {
  return stats.isSymbolicLink() || stats.isReparsePoint?.() === true;
}

function safeFileBytes(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageRootScanError();
  return BigInt(value);
}

async function hashRegularFile(filePath: string, expectedStats: StorageScanStats): Promise<string> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await nodeFs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.isSymbolicLink()
      || (expectedStats.dev !== undefined && openedStats.dev !== expectedStats.dev)
      || (expectedStats.ino !== undefined && openedStats.ino !== expectedStats.ino)) {
      throw new StorageRootScanError();
    }
    const expectedBytes = typeof expectedStats.size === 'bigint' ? expectedStats.size : safeFileBytes(expectedStats.size);
    const openedBytes = BigInt(openedStats.size);
    if (openedBytes !== expectedBytes) throw new StorageRootScanError();

    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let readBytes = 0n;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      readBytes += BigInt(read.bytesRead);
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    if (readBytes !== expectedBytes) throw new StorageRootScanError();
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}
