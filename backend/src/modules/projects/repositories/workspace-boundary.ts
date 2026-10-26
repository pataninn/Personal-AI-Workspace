export interface WorkspaceBoundarySnapshot {
  readonly status: 'ready' | 'unavailable';
  readonly code?: string;
}

export interface ResolvedProjectRoot {
  readonly canonicalRoot: string;
  readonly canonicalProjectRoot: string;
}

export interface ProjectRootScope {
  readonly ownerId: string;
  readonly projectId: string;
  readonly storageKind: 'legacy' | 'managed';
  readonly relativeRoot: string;
}

export interface ManagedOwnerDirectoryInventory {
  readonly ownerId: string;
  readonly unsafe: boolean;
  readonly projectIds: readonly string[];
}

export interface ManagedNamespaceInventory {
  readonly configured: boolean;
  readonly unattributableEntries: boolean;
  readonly owners: readonly ManagedOwnerDirectoryInventory[];
}

export interface ManagedProjectRootAllocation {
  readonly relativeRoot: string;
  /** Discards only this allocation, only while it is still empty. */
  discardIfEmpty(): Promise<void>;
}

export interface IWorkspaceBoundary {
  getSnapshot(): Promise<WorkspaceBoundarySnapshot>;
  assertReady(): Promise<void>;
  validateProjectRoot(relativeRoot: string): Promise<string>;
  createProjectRoot?(relativeRoot: string): Promise<string>;
  createManagedProjectRoot?(ownerId: string, projectId: string): Promise<string>;
  allocateManagedProjectRoot?(ownerId: string, projectId: string): Promise<ManagedProjectRootAllocation>;
  removeManagedProjectRoot?(ownerId: string, projectId: string): Promise<void>;
  resolveProjectRoot?(scope: ProjectRootScope): Promise<ResolvedProjectRoot>;
  getManagedSnapshot?(): Promise<WorkspaceBoundarySnapshot>;
  inspectManagedNamespace?(): Promise<ManagedNamespaceInventory>;
}
