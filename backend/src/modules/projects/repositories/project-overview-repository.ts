import type { Project } from '@/modules/projects/domain/project-types';
import type { ProjectTaskImportance, ProjectTaskStatus } from '@/modules/tasks/domain/project-task';

export interface ActiveProjectSummary extends Project {
  readonly lastActivityAt: Date;
}

export interface HomeTaskSummary {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly status: ProjectTaskStatus;
  readonly importance: ProjectTaskImportance;
  readonly deadline: string | null;
  readonly version: number;
}

export interface ProjectOverview {
  readonly projects: readonly ActiveProjectSummary[];
  readonly tasks: readonly HomeTaskSummary[];
}

export interface IProjectOverviewRepository {
  getOverview(ownerId: string, taskLimit: number): Promise<ProjectOverview>;
}
