import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';

export interface ListProjectFactsInput {
  readonly ownerId: string;
  readonly projectId: string;
}

export class ListProjectFactsUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly factRepository: IProjectFactRepository
  ) {}

  public async execute(input: ListProjectFactsInput): Promise<readonly ProjectFact[]> {
    const project = await this.projectRepository.findByIdForOwner(input.ownerId, input.projectId);
    if (!project) {
      throw new ProjectNotFoundError();
    }
    return this.factRepository.listActiveByProject(input.ownerId, project.id);
  }
}
