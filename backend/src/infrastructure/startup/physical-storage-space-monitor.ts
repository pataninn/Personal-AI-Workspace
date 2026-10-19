import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

export type PhysicalStorageVolume = 'legacy_workspace' | 'managed_workspaces' | 'recovery';

export interface PhysicalStorageRoot {
  readonly volume: PhysicalStorageVolume;
  readonly path: string;
  /** Root-specific marker/identity checks run before statfs. */
  readonly isTrusted?: () => Promise<boolean>;
}

export interface PhysicalStorageMonitorLogger {
  warn(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
}

export interface PhysicalStorageStats {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isReparsePoint?(): boolean;
}

export interface PhysicalStorageFileSystem {
  lstat(filePath: string): Promise<PhysicalStorageStats>;
  realpath(filePath: string): Promise<string>;
  statfs(filePath: string): Promise<{ readonly bavail: bigint; readonly bsize: bigint }>;
}

const defaultFileSystem: PhysicalStorageFileSystem = {
  lstat: async (filePath) => await nodeFs.lstat(filePath),
  realpath: async (filePath) => await nodeFs.realpath(filePath),
  statfs: async (filePath) => {
    const stats = await nodeFs.statfs(filePath, { bigint: true });
    return { bavail: stats.bavail, bsize: stats.bsize };
  }
};

type ObservationState = 'normal' | 'low' | 'unavailable';

/** Observes process-visible mount capacity; it never changes quota or write admission. */
export class PhysicalStorageSpaceMonitor {
  private readonly previous = new Map<PhysicalStorageVolume, ObservationState>();

  public constructor(
    private readonly options: {
      readonly roots: readonly PhysicalStorageRoot[];
      readonly warningFreeBytes?: bigint;
      readonly logger: PhysicalStorageMonitorLogger;
      readonly fileSystem?: PhysicalStorageFileSystem;
    }
  ) {
    if (options.warningFreeBytes !== undefined && options.warningFreeBytes <= 0n) {
      throw new TypeError('The physical-storage warning threshold must be positive.');
    }
    if (new Set(options.roots.map(({ volume }) => volume)).size !== options.roots.length) {
      throw new TypeError('Each observed physical-storage volume must have one root.');
    }
  }

  public async observe(): Promise<void> {
    const fileSystem = this.options.fileSystem ?? defaultFileSystem;
    for (const root of this.options.roots) {
      const prior = this.previous.get(root.volume);
      try {
        if (root.isTrusted && !(await root.isTrusted())) throw new Error('Root identity is unavailable.');
        await assertCanonicalDirectory(root.path, fileSystem);
        const stats = await fileSystem.statfs(root.path);
        if (stats.bavail < 0n || stats.bsize <= 0n) throw new Error('Filesystem capacity is invalid.');
        const availableBytes = stats.bavail * stats.bsize;
        const low = this.options.warningFreeBytes !== undefined && availableBytes < this.options.warningFreeBytes;
        if (prior === 'unavailable') {
          this.options.logger.info({ volume: root.volume, state: 'available' }, 'Physical storage observation recovered.');
        }
        if (low && prior !== 'low') {
          this.options.logger.warn({
            volume: root.volume,
            availableBytes: availableBytes.toString(),
            warningFreeBytes: this.options.warningFreeBytes?.toString()
          }, 'Process-visible physical storage is below its configured warning threshold.');
        } else if (!low && prior === 'low') {
          this.options.logger.info({
            volume: root.volume,
            availableBytes: availableBytes.toString()
          }, 'Process-visible physical storage is above its configured warning threshold again.');
        }
        this.previous.set(root.volume, low ? 'low' : 'normal');
      } catch {
        if (prior !== 'unavailable') {
          this.options.logger.warn(
            { volume: root.volume, state: 'unavailable' },
            'Physical storage availability could not be observed; no capacity value is assumed.'
          );
        }
        this.previous.set(root.volume, 'unavailable');
      }
    }
  }
}

async function assertCanonicalDirectory(filePath: string, fileSystem: PhysicalStorageFileSystem): Promise<void> {
  const canonicalPath = path.resolve(filePath);
  const stats = await fileSystem.lstat(canonicalPath);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.isReparsePoint?.() === true) {
    throw new Error('The configured storage root is not a canonical directory.');
  }
  if (path.resolve(await fileSystem.realpath(canonicalPath)) !== canonicalPath) {
    throw new Error('The configured storage root resolves through an alias.');
  }
}
