import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';

export interface GetProjectInput {
  readonly ownerId: string;
  readonly projectId: string;
}

export class GetProjectUseCase {
  public constructor(private readonly projectRepository: IProjectRepository) {}

  public async execute(input: GetProjectInput): Promise<Project> {
    const project = await this.projectRepository.findByIdForOwner(input.ownerId, input.projectId);
    if (!project) {
      throw new ProjectNotFoundError();
    }
    return project;
  }
}

