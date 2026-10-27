export type ProjectStatus = 'active' | 'archived';
export type ProjectStorageKind = 'legacy' | 'managed';

export interface Project {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly slug: string;
  readonly relativeRoot: string | null;
  /** Internal mount mapping. This field is never serialized in project DTOs. */
  readonly storageKind: ProjectStorageKind | null;
  readonly objective: string | null;
  readonly status: ProjectStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ProjectWorkspaceMode = 'planning' | 'file_backed';

export interface ProjectCapabilities {
  readonly planning: true;
  readonly fileAccess: boolean;
}

export function projectWorkspaceMode(project: Pick<Project, 'relativeRoot'>): ProjectWorkspaceMode {
  return project.relativeRoot === null ? 'planning' : 'file_backed';
}

export function projectCapabilities(project: Pick<Project, 'relativeRoot'>): ProjectCapabilities {
  return { planning: true, fileAccess: project.relativeRoot !== null };
}

