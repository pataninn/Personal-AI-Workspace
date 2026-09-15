import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';

export interface ListProjectsInput {
  readonly ownerId: string;
  readonly includeArchived: boolean;
}

export class ListProjectsUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly workspaceBoundary: IWorkspaceBoundary
  ) {}

  public async execute(input: ListProjectsInput): Promise<readonly Project[]> {
    await this.workspaceBoundary.assertReady();
    return this.projectRepository.listByOwner(input.ownerId, input.includeArchived);
  }
}

