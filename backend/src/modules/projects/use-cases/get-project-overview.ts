import type { IProjectOverviewRepository, ProjectOverview } from '@/modules/projects/repositories/project-overview-repository';

/** Returns activity-ranked projects and a bounded, deadline-ranked task list. */
export class GetProjectOverviewUseCase {
  public constructor(private readonly repository: IProjectOverviewRepository) {}

  public async execute(input: { readonly ownerId: string; readonly taskLimit: number }): Promise<ProjectOverview> {
    return this.repository.getOverview(input.ownerId, input.taskLimit);
  }
}
