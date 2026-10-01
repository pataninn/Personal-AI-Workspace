import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

import {
  ProjectRootInvalidError,
  ProjectRootNotFoundError,
  ProjectRootReparsePointError,
  WorkspaceBoundaryUnavailableError
} from '@/modules/projects/domain/project-errors';
import { normalizeProjectRoot } from '@/modules/projects/domain/project-root-policy';
import type { IWorkspaceBoundary, WorkspaceBoundarySnapshot } from '@/modules/projects/repositories/workspace-boundary';

export interface WorkspaceStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isReparsePoint?(): boolean;
}

export interface WorkspaceFileSystem {
  lstat(filePath: string): Promise<WorkspaceStats>;
  mkdir?(filePath: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  realpath(filePath: string): Promise<string>;
}

const defaultFileSystem: WorkspaceFileSystem = {
  lstat: (filePath) => nodeFs.lstat(filePath),
  mkdir: async (filePath) => { await nodeFs.mkdir(filePath); },
  readFile: (filePath) => nodeFs.readFile(filePath, 'utf8'),
  realpath: (filePath) => nodeFs.realpath(filePath)
};

export interface WorkspaceBoundaryOptions {
  readonly containerRoot: string;
  readonly identityFile: string;
  readonly expectedIdentity: string;
  readonly fileSystem?: WorkspaceFileSystem;
}

function isReparsePoint(stats: WorkspaceStats): boolean {
  return stats.isSymbolicLink() || stats.isReparsePoint?.() === true;
}

function isContained(root: string, target: string): boolean {
  const canonicalRoot = root.toLocaleLowerCase('en-US');
  const canonicalTarget = target.toLocaleLowerCase('en-US');
  const relative = path.posix.relative(canonicalRoot, canonicalTarget);
  return relative.length > 0 && relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative);
}

export class WorkspaceBoundaryAdapter implements IWorkspaceBoundary {
  private readonly fileSystem: WorkspaceFileSystem;

  public constructor(private readonly options: WorkspaceBoundaryOptions) {
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
  }

  public async getSnapshot(): Promise<WorkspaceBoundarySnapshot> {
    try {
      await this.verifyConfiguredRoot();
      return { status: 'ready' };
    } catch (error: unknown) {
      return { status: 'unavailable', code: error instanceof Error ? error.name : 'WORKSPACE_UNAVAILABLE' };
    }
  }

  public async assertReady(): Promise<void> {
    try {
      await this.verifyConfiguredRoot();
    } catch {
      throw new WorkspaceBoundaryUnavailableError();
    }
  }

  public async validateProjectRoot(relativeRoot: string): Promise<string> {
    const normalizedRoot = normalizeProjectRoot(relativeRoot);
    await this.assertReady();
    if (normalizedRoot === '.') {
      return normalizedRoot;
    }
    const segments = normalizedRoot.split('/');
    let currentPath = this.options.containerRoot;
    for (const segment of segments) {
      currentPath = path.posix.join(currentPath, segment);
      await this.assertDirectoryWithoutReparse(currentPath);
    }
    const canonicalRoot = await this.fileSystem.realpath(this.options.containerRoot);
    const canonicalProjectRoot = await this.fileSystem.realpath(currentPath);
    if (!isContained(canonicalRoot, canonicalProjectRoot)) {
      throw new ProjectRootInvalidError();
    }
    const canonicalRelativeRoot = path.posix.relative(canonicalRoot, canonicalProjectRoot);
    if (canonicalRelativeRoot.length === 0 || path.posix.isAbsolute(canonicalRelativeRoot)) {
      throw new ProjectRootInvalidError();
    }
    return normalizeProjectRoot(canonicalRelativeRoot);
  }

  public async createProjectRoot(relativeRoot: string): Promise<string> {
    const normalizedRoot = normalizeProjectRoot(relativeRoot);
    await this.assertReady();
    if (normalizedRoot === '.') {
      return normalizedRoot;
    }
    if (!this.fileSystem.mkdir) {
      throw new WorkspaceBoundaryUnavailableError();
    }
    let currentPath = this.options.containerRoot;
    for (const segment of normalizedRoot.split('/')) {
      currentPath = path.posix.join(currentPath, segment);
      try {
        await this.fileSystem.lstat(currentPath);
      } catch {
        try {
          await this.fileSystem.mkdir(currentPath);
        } catch (error: unknown) {
          // Another request may have created the same directory; validate it below.
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) {
            throw new WorkspaceBoundaryUnavailableError();
          }
        }
      }
      await this.assertDirectoryWithoutReparse(currentPath);
    }
    const canonicalRoot = await this.fileSystem.realpath(this.options.containerRoot);
    const canonicalProjectRoot = await this.fileSystem.realpath(currentPath);
    if (!isContained(canonicalRoot, canonicalProjectRoot)) {
      throw new ProjectRootInvalidError();
    }
    return normalizeProjectRoot(path.posix.relative(canonicalRoot, canonicalProjectRoot));
  }

  private async verifyConfiguredRoot(): Promise<void> {
    if (this.options.containerRoot !== '/workspace' || this.options.expectedIdentity.trim().length === 0) {
      throw new WorkspaceBoundaryUnavailableError();
    }
    const rootStats = await this.fileSystem.lstat(this.options.containerRoot);
    if (!rootStats.isDirectory() || isReparsePoint(rootStats)) {
      throw new WorkspaceBoundaryUnavailableError();
    }
    const canonicalRoot = await this.fileSystem.realpath(this.options.containerRoot);
    if (canonicalRoot !== this.options.containerRoot) {
      throw new WorkspaceBoundaryUnavailableError();
    }
    const markerStats = await this.fileSystem.lstat(this.options.identityFile);
    if (!markerStats.isFile() || isReparsePoint(markerStats)) {
      throw new WorkspaceBoundaryUnavailableError();
    }
    const marker = (await this.fileSystem.readFile(this.options.identityFile)).trim();
    if (marker !== this.options.expectedIdentity) {
      throw new WorkspaceBoundaryUnavailableError();
    }
  }

  private async assertDirectoryWithoutReparse(filePath: string): Promise<void> {
    let stats: WorkspaceStats;
    try {
      stats = await this.fileSystem.lstat(filePath);
    } catch {
      throw new ProjectRootNotFoundError();
    }
    if (isReparsePoint(stats)) {
      throw new ProjectRootReparsePointError();
    }
    if (!stats.isDirectory()) {
      throw new ProjectRootNotFoundError();
    }
  }
}
