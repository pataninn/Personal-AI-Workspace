import { AiRunNotFoundError } from '@/modules/ai-runs/domain/ai-run-errors';
import { ProjectArchivedError } from '@/modules/conversations/domain/conversation-errors';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { requireProjectFileRoot } from '@/modules/projects/domain/project-file-root';

/**
 * Mutating run endpoints must check the project immediately before asking the
 * run repository to transition state. The run lookup also keeps cross-owner
 * and cross-project errors indistinguishable from a missing run.
 */
export async function assertActiveAiRunProject(
  aiRunRepository: IAiRunRepository,
  projectRepository: IProjectRepository,
  ownerId: string,
  runId: string
): Promise<void> {
  const run = await aiRunRepository.findByIdForOwner(ownerId, runId);
  if (!run) {
    throw new AiRunNotFoundError();
  }
  const project = await projectRepository.findByIdForOwner(ownerId, run.projectId);
  if (!project) {
    throw new AiRunNotFoundError();
  }
  if (project.status === 'archived') {
    throw new ProjectArchivedError();
  }
  requireProjectFileRoot(project);
}

/** Read paths retain archived-project access but must not expose file-backed run data for planning projects. */
export async function assertAiRunProjectHasFileRoot(
  projectRepository: IProjectRepository,
  ownerId: string,
  projectId: string
): Promise<void> {
  const project = await projectRepository.findByIdForOwner(ownerId, projectId);
  if (!project) {
    throw new AiRunNotFoundError();
  }
  requireProjectFileRoot(project);
}
