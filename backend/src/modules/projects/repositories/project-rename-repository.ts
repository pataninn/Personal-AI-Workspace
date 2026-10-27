import type { Project } from '@/modules/projects/domain/project-types';

export interface RenameProjectRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly expectedVersion: number;
  readonly name: string;
  readonly slug: string;
}

export interface IProjectRenameRepository {
  rename(input: RenameProjectRecord): Promise<Project | null>;
}
