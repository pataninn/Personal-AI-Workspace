import type { ProjectFact } from '@/modules/memory/domain/project-fact';

export interface CreateProjectFactRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly key: string;
  readonly title: string;
  readonly content: string;
}

export interface UpdateProjectFactRecord extends CreateProjectFactRecord {
  readonly factId: string;
  readonly expectedVersion: number;
}

export interface ProjectFactVersionRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly factId: string;
  readonly expectedVersion: number;
}

export interface IProjectFactRepository {
  listActiveByProject(ownerId: string, projectId: string): Promise<readonly ProjectFact[]>;
  findActiveById(ownerId: string, projectId: string, factId: string): Promise<ProjectFact | null>;
  findActiveByIds(ownerId: string, projectId: string, factIds: readonly string[]): Promise<readonly ProjectFact[]>;
  create(input: CreateProjectFactRecord): Promise<ProjectFact>;
  update(input: UpdateProjectFactRecord): Promise<ProjectFact | null>;
  verify(input: ProjectFactVersionRecord): Promise<ProjectFact | null>;
  softDelete(input: ProjectFactVersionRecord): Promise<boolean>;
}
