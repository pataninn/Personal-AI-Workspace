import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';

export interface GetProjectInput {
  readonly ownerId: string;
  readonly projectId: string;
}

export class GetProjectUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly workspaceBoundary: IWorkspaceBoundary
  ) {}

  public async execute(input: GetProjectInput): Promise<Project> {
    await this.workspaceBoundary.assertReady();
    const project = await this.projectRepository.findByIdForOwner(input.ownerId, input.projectId);
    if (!project) {
      throw new ProjectNotFoundError();
    }
    return project;
  }
}

