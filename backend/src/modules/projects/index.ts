export { createProjectRouter, type ProjectRouterDependencies } from '@/modules/projects/controllers/project-router';
export {
  CreateProjectUseCase,
  GetProjectUseCase,
  ListProjectsUseCase,
  UpdateProjectStatusUseCase
} from '@/modules/projects/use-cases/project-use-cases';
export type { Project, ProjectStatus } from '@/modules/projects/domain/project-types';
export type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
export type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';

