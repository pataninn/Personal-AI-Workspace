export { createProjectRouter, type ProjectRouterDependencies } from '@/modules/projects/controllers/project-router';
export {
  CreateProjectUseCase,
  GetProjectUseCase,
  ListProjectsUseCase,
  UpdateProjectStatusUseCase
} from '@/modules/projects/use-cases/project-use-cases';
export type { Project, ProjectStatus } from '@/modules/projects/domain/project-types';
export type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
export type { IProjectWorkspaceRepository } from '@/modules/projects/repositories/project-workspace-repository';
export type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
export { WorkspacePlanningUseCases } from '@/modules/projects/use-cases/workspace-planning-use-cases';
export type { IWorkspacePlanningUseCases } from '@/modules/projects/use-cases/workspace-planning-use-cases';
export { DeleteProjectUseCase } from '@/modules/projects/use-cases/delete-project';
export { GetProjectOverviewUseCase } from '@/modules/projects/use-cases/get-project-overview';
