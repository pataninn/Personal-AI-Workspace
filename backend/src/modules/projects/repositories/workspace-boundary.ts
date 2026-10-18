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

export interface IWorkspaceBoundary {
  getSnapshot(): Promise<WorkspaceBoundarySnapshot>;
  assertReady(): Promise<void>;
  validateProjectRoot(relativeRoot: string): Promise<string>;
  createProjectRoot?(relativeRoot: string): Promise<string>;
  createManagedProjectRoot?(ownerId: string, projectId: string): Promise<string>;
  resolveProjectRoot?(scope: ProjectRootScope): Promise<ResolvedProjectRoot>;
  getManagedSnapshot?(): Promise<WorkspaceBoundarySnapshot>;
}
