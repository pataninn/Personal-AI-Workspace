import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

import {
  ProjectRootInvalidError,
  ProjectRootNotFoundError,
  ProjectRootReparsePointError,
  WorkspaceBoundaryUnavailableError,
  WorkspaceStorageUnavailableError
} from '@/modules/projects/domain/project-errors';
import { normalizeProjectRoot } from '@/modules/projects/domain/project-root-policy';
import type {
  IWorkspaceBoundary,
  ManagedNamespaceInventory,
  ManagedOwnerDirectoryInventory,
  ProjectRootScope,
  ResolvedProjectRoot,
  WorkspaceBoundarySnapshot
} from '@/modules/projects/repositories/workspace-boundary';

export interface WorkspaceStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isReparsePoint?(): boolean;
  readonly dev?: number | bigint;
  readonly ino?: number | bigint;
}

export interface WorkspaceFileSystem {
  lstat(filePath: string): Promise<WorkspaceStats>;
  mkdir?(filePath: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  realpath(filePath: string): Promise<string>;
  readdir?(directoryPath: string): Promise<readonly string[]>;
  unlink?(filePath: string): Promise<void>;
  rmdir?(directoryPath: string): Promise<void>;
}

const defaultFileSystem: WorkspaceFileSystem = {
  lstat: (filePath) => nodeFs.lstat(filePath),
  mkdir: async (filePath) => { await nodeFs.mkdir(filePath); },
  readFile: (filePath) => nodeFs.readFile(filePath, 'utf8'),
  realpath: (filePath) => nodeFs.realpath(filePath),
  readdir: async (directoryPath) => await nodeFs.readdir(directoryPath),
  unlink: async (filePath) => await nodeFs.unlink(filePath),
  rmdir: async (directoryPath) => await nodeFs.rmdir(directoryPath)
};

export interface WorkspaceBoundaryOptions {
  readonly containerRoot: string;
  readonly identityFile: string;
  readonly expectedIdentity: string;
  readonly managedContainerRoot?: string;
  readonly managedIdentityFile?: string;
  readonly managedExpectedIdentity?: string;
  readonly legacyOwnerId?: () => Promise<string | null>;
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

  public async getManagedSnapshot(): Promise<WorkspaceBoundarySnapshot> {
    try {
      await this.verifyManagedRoot();
      return { status: 'ready' };
    } catch (error: unknown) {
      return { status: 'unavailable', code: error instanceof Error ? error.name : 'WORKSPACE_STORAGE_UNAVAILABLE' };
    }
  }

  public async inspectManagedNamespace(): Promise<ManagedNamespaceInventory> {
    if (!this.options.managedContainerRoot || !this.options.managedIdentityFile || !this.options.managedExpectedIdentity?.trim()) {
      return { configured: false, unattributableEntries: false, owners: [] };
    }
    const root = await this.verifyManagedRoot();
    if (!this.fileSystem.readdir) throw new WorkspaceStorageUnavailableError();
    let entries: readonly string[];
    try {
      entries = await this.fileSystem.readdir(root);
    } catch {
      throw new WorkspaceStorageUnavailableError();
    }
    const owners: ManagedOwnerDirectoryInventory[] = [];
    let unattributableEntries = false;
    for (const entry of entries) {
      if (entry === path.posix.basename(this.options.managedIdentityFile)) continue;
      if (!isCanonicalUuid(entry)) {
        unattributableEntries = true;
        continue;
      }
      owners.push(await this.inspectManagedOwnerDirectory(root, entry));
    }
    return { configured: true, unattributableEntries, owners };
  }

  public async createManagedProjectRoot(ownerId: string, projectId: string): Promise<string> {
    await this.verifyManagedRoot();
    if (!isUuid(ownerId) || !isUuid(projectId) || !this.fileSystem.mkdir) {
      throw new WorkspaceStorageUnavailableError();
    }
    const root = this.options.managedContainerRoot;
    if (!root) throw new WorkspaceStorageUnavailableError();
    let currentPath = root;
    for (const [index, segment] of [ownerId, 'projects', projectId].entries()) {
      currentPath = path.posix.join(currentPath, segment);
      let exists = true;
      try {
        await this.fileSystem.lstat(currentPath);
      } catch (error: unknown) {
        if (!hasFileSystemCode(error, 'ENOENT')) throw new WorkspaceStorageUnavailableError();
        exists = false;
      }
      if (index === 2 && exists) throw new WorkspaceStorageUnavailableError();
      if (!exists) {
        try {
          await this.fileSystem.mkdir(currentPath);
        } catch (error: unknown) {
          if (!(index < 2 && hasFileSystemCode(error, 'EEXIST'))) {
            throw new WorkspaceStorageUnavailableError();
          }
        }
      }
      await this.assertDirectoryWithoutReparse(currentPath);
      if (await this.fileSystem.realpath(currentPath) !== currentPath) {
        throw new WorkspaceStorageUnavailableError();
      }
    }
    return `projects/${projectId}`;
  }

  /** Removes only one canonical managed project child; owner and namespace directories are retained. */
  public async removeManagedProjectRoot(ownerId: string, projectId: string): Promise<void> {
    if (!isCanonicalUuid(ownerId) || !isCanonicalUuid(projectId)
      || !this.fileSystem.readdir || !this.fileSystem.unlink || !this.fileSystem.rmdir) {
      throw new WorkspaceStorageUnavailableError();
    }
    const root = await this.verifyManagedRoot();
    const ownerPath = path.posix.join(root, ownerId);
    const projectsPath = path.posix.join(ownerPath, 'projects');
    for (const parent of [ownerPath, projectsPath]) {
      try {
        await this.assertCanonicalManagedDirectory(root, parent);
      } catch (error: unknown) {
        if (hasFileSystemCode(error, 'ENOENT')) return;
        throw new WorkspaceStorageUnavailableError();
      }
    }
    const projectPath = path.posix.join(projectsPath, projectId);
    try {
      await this.assertCanonicalManagedDirectory(projectsPath, projectPath);
    } catch (error: unknown) {
      if (hasFileSystemCode(error, 'ENOENT')) return;
      throw new WorkspaceStorageUnavailableError();
    }
    try {
      await this.removeManagedTree(root, projectPath);
      await this.fileSystem.rmdir(projectPath);
    } catch {
      throw new WorkspaceStorageUnavailableError();
    }
    try {
      await this.fileSystem.lstat(projectPath);
      throw new WorkspaceStorageUnavailableError();
    } catch (error: unknown) {
      if (!hasFileSystemCode(error, 'ENOENT')) throw new WorkspaceStorageUnavailableError();
    }
  }

  public async resolveProjectRoot(scope: ProjectRootScope): Promise<ResolvedProjectRoot> {
    if (scope.storageKind === 'managed') {
      if (!isUuid(scope.ownerId) || !isUuid(scope.projectId) || scope.relativeRoot !== `projects/${scope.projectId}`) {
        throw new WorkspaceStorageUnavailableError();
      }
      const canonicalRoot = await this.verifyManagedRoot();
      const canonicalProjectRoot = await this.resolveManagedProjectRoot(canonicalRoot, scope.ownerId, scope.projectId);
      return { canonicalRoot, canonicalProjectRoot };
    }
    const legacyOwner = await this.options.legacyOwnerId?.();
    if (!legacyOwner || scope.ownerId !== legacyOwner) {
      throw new WorkspaceBoundaryUnavailableError();
    }
    const relativeRoot = await this.validateProjectRoot(scope.relativeRoot);
    const canonicalRoot = await this.fileSystem.realpath(this.options.containerRoot);
    const projectPath = relativeRoot === '.' ? canonicalRoot : path.posix.join(canonicalRoot, ...relativeRoot.split('/'));
    const canonicalProjectRoot = await this.fileSystem.realpath(projectPath);
    if (relativeRoot === '.') {
      if (canonicalProjectRoot !== canonicalRoot) throw new ProjectRootInvalidError();
    } else if (!isContained(canonicalRoot, canonicalProjectRoot)) {
      throw new ProjectRootInvalidError();
    }
    return { canonicalRoot, canonicalProjectRoot };
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

  private async verifyManagedRoot(): Promise<string> {
    const root = this.options.managedContainerRoot;
    const markerFile = this.options.managedIdentityFile;
    const expectedIdentity = this.options.managedExpectedIdentity;
    try {
      if (root !== '/account-workspaces'
        || markerFile !== '/account-workspaces/.personal-ai-managed-storage-identity'
        || !expectedIdentity?.trim()) {
        throw new WorkspaceStorageUnavailableError();
      }
      await this.verifyConfiguredRoot();
      const rootStats = await this.fileSystem.lstat(root);
      if (!rootStats.isDirectory() || isReparsePoint(rootStats)) throw new WorkspaceStorageUnavailableError();
      const canonicalRoot = await this.fileSystem.realpath(root);
      if (canonicalRoot !== root) throw new WorkspaceStorageUnavailableError();
      const markerStats = await this.fileSystem.lstat(markerFile);
      if (!markerStats.isFile() || isReparsePoint(markerStats)) throw new WorkspaceStorageUnavailableError();
      if ((await this.fileSystem.readFile(markerFile)).trim() !== expectedIdentity) throw new WorkspaceStorageUnavailableError();
      const legacyStats = await this.fileSystem.lstat(this.options.containerRoot);
      if (!hasDirectoryIdentity(rootStats) || !hasDirectoryIdentity(legacyStats) || sameDirectoryIdentity(rootStats, legacyStats)) {
        throw new WorkspaceStorageUnavailableError();
      }
      const legacyRoot = await this.fileSystem.realpath(this.options.containerRoot);
      if (isContained(legacyRoot, canonicalRoot) || isContained(canonicalRoot, legacyRoot)) throw new WorkspaceStorageUnavailableError();
      return canonicalRoot;
    } catch {
      throw new WorkspaceStorageUnavailableError();
    }
  }

  private async resolveManagedProjectRoot(canonicalRoot: string, ownerId: string, projectId: string): Promise<string> {
    const ownerRoot = path.posix.join(canonicalRoot, ownerId);
    const projectsRoot = path.posix.join(ownerRoot, 'projects');
    const projectRoot = path.posix.join(projectsRoot, projectId);
    for (const target of [ownerRoot, projectsRoot, projectRoot]) {
      await this.assertDirectoryWithoutReparse(target);
      const resolved = await this.fileSystem.realpath(target);
      if (!isContained(canonicalRoot, resolved)) throw new WorkspaceStorageUnavailableError();
    }
    const resolved = await this.fileSystem.realpath(projectRoot);
    return resolved;
  }

  private async inspectManagedOwnerDirectory(root: string, ownerId: string): Promise<ManagedOwnerDirectoryInventory> {
    const ownerPath = path.posix.join(root, ownerId);
    try {
      await this.assertCanonicalManagedDirectory(root, ownerPath);
    } catch {
      return { ownerId, unsafe: true, projectIds: [] };
    }
    const projectsPath = path.posix.join(ownerPath, 'projects');
    let projectsStats: WorkspaceStats;
    try {
      projectsStats = await this.fileSystem.lstat(projectsPath);
    } catch (error: unknown) {
      if (hasFileSystemCode(error, 'ENOENT')) return { ownerId, unsafe: false, projectIds: [] };
      return { ownerId, unsafe: true, projectIds: [] };
    }
    try {
      await this.assertCanonicalManagedDirectory(ownerPath, projectsPath, projectsStats);
      if (!this.fileSystem.readdir) return { ownerId, unsafe: true, projectIds: [] };
      const projectEntries = await this.fileSystem.readdir(projectsPath);
      const projectIds: string[] = [];
      let unsafe = false;
      for (const projectId of projectEntries) {
        if (!isCanonicalUuid(projectId)) {
          unsafe = true;
          continue;
        }
        try {
          await this.assertCanonicalManagedDirectory(projectsPath, path.posix.join(projectsPath, projectId));
          projectIds.push(projectId);
        } catch {
          unsafe = true;
        }
      }
      return { ownerId, unsafe, projectIds };
    } catch {
      return { ownerId, unsafe: true, projectIds: [] };
    }
  }

  private async removeManagedTree(managedRoot: string, directoryPath: string): Promise<void> {
    await this.validateManagedTree(managedRoot, directoryPath);
    await this.assertCanonicalManagedDirectory(managedRoot, directoryPath);
    const entries = await this.fileSystem.readdir!(directoryPath);
    for (const entry of entries) {
      if (!entry || entry === '.' || entry === '..' || path.posix.basename(entry) !== entry || entry.includes('/')) {
        throw new WorkspaceStorageUnavailableError();
      }
      const child = path.posix.join(directoryPath, entry);
      const stats = await this.fileSystem.lstat(child);
      if (isReparsePoint(stats)) throw new WorkspaceStorageUnavailableError();
      if (stats.isDirectory()) {
        await this.removeManagedTree(managedRoot, child);
        await this.fileSystem.rmdir!(child);
      } else if (stats.isFile()) {
        const resolved = await this.fileSystem.realpath(child);
        if (resolved !== child || !isContained(managedRoot, resolved)) throw new WorkspaceStorageUnavailableError();
        await this.fileSystem.unlink!(child);
      } else {
        throw new WorkspaceStorageUnavailableError();
      }
    }
  }

  private async validateManagedTree(managedRoot: string, directoryPath: string): Promise<void> {
    await this.assertCanonicalManagedDirectory(managedRoot, directoryPath);
    for (const entry of await this.fileSystem.readdir!(directoryPath)) {
      if (!entry || entry === '.' || entry === '..' || path.posix.basename(entry) !== entry || entry.includes('/')) {
        throw new WorkspaceStorageUnavailableError();
      }
      const child = path.posix.join(directoryPath, entry);
      const stats = await this.fileSystem.lstat(child);
      if (isReparsePoint(stats)) throw new WorkspaceStorageUnavailableError();
      if (stats.isDirectory()) {
        await this.validateManagedTree(managedRoot, child);
      } else if (stats.isFile()) {
        const resolved = await this.fileSystem.realpath(child);
        if (resolved !== child || !isContained(managedRoot, resolved)) throw new WorkspaceStorageUnavailableError();
      } else {
        throw new WorkspaceStorageUnavailableError();
      }
    }
  }

  private async assertCanonicalManagedDirectory(parent: string, target: string, stats?: WorkspaceStats): Promise<void> {
    const targetStats = stats ?? await this.fileSystem.lstat(target);
    if (!targetStats.isDirectory() || isReparsePoint(targetStats)) throw new WorkspaceStorageUnavailableError();
    const [canonicalParent, canonicalTarget] = await Promise.all([
      this.fileSystem.realpath(parent),
      this.fileSystem.realpath(target)
    ]);
    if (canonicalParent !== parent || canonicalTarget !== target || !isContained(parent, target)) {
      throw new WorkspaceStorageUnavailableError();
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isCanonicalUuid(value: string): boolean {
  return value === value.toLowerCase() && isUuid(value);
}

function sameDirectoryIdentity(left: WorkspaceStats, right: WorkspaceStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasDirectoryIdentity(stats: WorkspaceStats): boolean {
  return stats.dev !== undefined && stats.ino !== undefined;
}

function hasFileSystemCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
