import { ProjectNotFoundError, ProjectVersionConflictError } from '@/modules/projects/domain/project-errors';
import { normalizeProjectName } from '@/modules/projects/domain/project-root-policy';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IProjectRenameRepository } from '@/modules/projects/repositories/project-rename-repository';

export class RenameProjectUseCase {
  public constructor(private readonly projects: Pick<IProjectRepository, 'findByIdForOwner'> & IProjectRenameRepository) {}

  public async execute(input: { readonly ownerId: string; readonly projectId: string; readonly expectedVersion: number; readonly name: unknown }): Promise<Project> {
    const identity = normalizeProjectName(input.name);
    const current = await this.projects.findByIdForOwner(input.ownerId, input.projectId);
    if (!current) throw new ProjectNotFoundError();
    if (current.version !== input.expectedVersion) throw new ProjectVersionConflictError();
    const updated = await this.projects.rename({ ...input, ...identity });
    if (!updated) throw new ProjectVersionConflictError();
    return updated;
  }
}
