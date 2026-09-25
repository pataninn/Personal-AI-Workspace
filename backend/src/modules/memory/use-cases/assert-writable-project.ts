import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { ProjectFactArchivedProjectError } from '@/modules/memory/domain/project-fact-errors';

export async function assertWritableProject(projectRepository: IProjectRepository, ownerId: string, projectId: string): Promise<void> {
  const project = await projectRepository.findByIdForOwner(ownerId, projectId);
  if (!project) {
    throw new ProjectNotFoundError();
  }
  if (project.status !== 'active') {
    throw new ProjectFactArchivedProjectError();
  }
}
