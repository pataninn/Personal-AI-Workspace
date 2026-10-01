export interface WorkspaceBoundarySnapshot {
  readonly status: 'ready' | 'unavailable';
  readonly code?: string;
}

export interface IWorkspaceBoundary {
  getSnapshot(): Promise<WorkspaceBoundarySnapshot>;
  assertReady(): Promise<void>;
  validateProjectRoot(relativeRoot: string): Promise<string>;
  createProjectRoot?(relativeRoot: string): Promise<string>;
}
