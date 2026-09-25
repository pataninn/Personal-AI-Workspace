export { createProjectFactRouter, type ProjectFactRouterDependencies } from '@/modules/memory/controllers/project-fact-router';
export { CreateProjectFactUseCase } from '@/modules/memory/use-cases/create-project-fact';
export { DeleteProjectFactUseCase } from '@/modules/memory/use-cases/delete-project-fact';
export { ListProjectFactsUseCase } from '@/modules/memory/use-cases/list-project-facts';
export { ReviewProjectFactUseCase } from '@/modules/memory/use-cases/review-project-fact';
export { UpdateProjectFactUseCase } from '@/modules/memory/use-cases/update-project-fact';
export type { ProjectFact, ProjectFactVerificationStatus } from '@/modules/memory/domain/project-fact';
export type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
