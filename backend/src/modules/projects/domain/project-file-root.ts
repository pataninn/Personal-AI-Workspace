import { ProjectRootNotAttachedError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';
import type { WorkspaceProjectScope } from '@/modules/files/domain/workspace-types';

/** Keeps nullable project metadata out of every string-rooted file boundary. */
export function requireProjectFileRoot(project: Pick<Project, 'relativeRoot'>): string {
  if (project.relativeRoot === null) {
    throw new ProjectRootNotAttachedError();
  }
  return project.relativeRoot;
}

/** Builds the only workspace scope accepted by file adapters from a persisted project. */
export function requireProjectFileScope(
  project: Pick<Project, 'id' | 'ownerId' | 'relativeRoot' | 'storageKind'>
): WorkspaceProjectScope {
  const relativeRoot = requireProjectFileRoot(project);
  if (project.storageKind === null) {
    throw new ProjectRootNotAttachedError();
  }
  return { ownerId: project.ownerId, projectId: project.id, storageKind: project.storageKind, relativeRoot };
}
