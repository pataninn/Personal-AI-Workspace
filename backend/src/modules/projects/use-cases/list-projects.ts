import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';

export interface ListProjectsInput {
  readonly ownerId: string;
  readonly includeArchived: boolean;
}

export class ListProjectsUseCase {
  public constructor(private readonly projectRepository: IProjectRepository) {}

  public async execute(input: ListProjectsInput): Promise<readonly Project[]> {
    return this.projectRepository.listByOwner(input.ownerId, input.includeArchived);
  }
}

