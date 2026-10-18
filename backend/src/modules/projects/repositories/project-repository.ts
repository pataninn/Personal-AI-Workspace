import type { Project, ProjectStatus, ProjectStorageKind } from '@/modules/projects/domain/project-types';

export interface CreateProjectRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly slug: string;
  readonly relativeRoot: string | null;
  readonly storageKind: ProjectStorageKind | null;
  readonly relativeRootKey?: string | null;
  readonly objective: string | null;
}

export interface UpdateProjectStatusRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly status: ProjectStatus;
  readonly expectedVersion: number;
}

export interface IProjectRepository {
  listByOwner(ownerId: string, includeArchived: boolean): Promise<readonly Project[]>;
  findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null>;
  listActiveRoots(ownerId: string): Promise<readonly string[]>;
  create(input: CreateProjectRecord): Promise<Project>;
  updateStatus(input: UpdateProjectStatusRecord): Promise<Project | null>;
}
