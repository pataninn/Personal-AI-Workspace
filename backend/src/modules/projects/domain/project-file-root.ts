import { ProjectRootNotAttachedError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';

/** Keeps nullable project metadata out of every string-rooted file boundary. */
export function requireProjectFileRoot(project: Pick<Project, 'relativeRoot'>): string {
  if (project.relativeRoot === null) {
    throw new ProjectRootNotAttachedError();
  }
  return project.relativeRoot;
}
