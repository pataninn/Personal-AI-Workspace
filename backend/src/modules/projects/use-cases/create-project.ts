import {
  assertProjectRootDoesNotOverlap,
  normalizeProjectName,
  normalizeProjectRoot,
  projectRootOverlapKey
} from '@/modules/projects/domain/project-root-policy';
import { ProjectObjectiveInvalidError, ProjectRootInvalidError, ProjectWorkspaceModeInvalidError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';

export interface CreateProjectInput {
  readonly ownerId: string;
  readonly name: unknown;
  readonly relativeRoot?: unknown;
  readonly workspaceMode?: unknown;
  readonly objective?: unknown;
}

export class CreateProjectUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly workspaceBoundary: IWorkspaceBoundary
  ) {}

  public async execute(input: CreateProjectInput): Promise<Project> {
    const identity = normalizeProjectName(input.name);
    const objective = normalizeProjectObjective(input.objective);
    if (input.workspaceMode === 'planning') {
      if (input.relativeRoot !== undefined) {
        throw new ProjectWorkspaceModeInvalidError('Planning workspaces must not include a folder.');
      }
      return this.projectRepository.create({
        ownerId: input.ownerId,
        name: identity.name,
        slug: identity.slug,
        relativeRoot: null,
        relativeRootKey: null,
        objective
      });
    }
    if (input.workspaceMode !== undefined && input.workspaceMode !== 'file_backed') {
      throw new ProjectWorkspaceModeInvalidError();
    }
    if (input.relativeRoot === undefined) {
      throw new ProjectRootInvalidError();
    }
    const requestedRoot = normalizeProjectRoot(input.relativeRoot);
    await this.workspaceBoundary.assertReady();
    const relativeRoot = requestedRoot;
    const activeRoots = await this.projectRepository.listActiveRoots(input.ownerId);
    assertProjectRootDoesNotOverlap(relativeRoot, activeRoots);
    const projectRoot = this.workspaceBoundary.createProjectRoot
      ? await this.workspaceBoundary.createProjectRoot(relativeRoot)
      : relativeRoot;
    assertProjectRootDoesNotOverlap(projectRoot, activeRoots);
    return this.projectRepository.create({
      ownerId: input.ownerId,
      name: identity.name,
      slug: identity.slug,
      relativeRoot: projectRoot,
      relativeRootKey: projectRootOverlapKey(projectRoot),
      objective
    });
  }
}

function normalizeProjectObjective(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ProjectObjectiveInvalidError();
  const objective = value.trim();
  if (objective.length > 2000) throw new ProjectObjectiveInvalidError();
  return objective || null;
}
