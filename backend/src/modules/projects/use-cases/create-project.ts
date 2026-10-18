import { randomUUID } from 'node:crypto';

import { normalizeProjectName } from '@/modules/projects/domain/project-root-policy';
import { ProjectObjectiveInvalidError, ProjectWorkspaceModeInvalidError, WorkspaceStorageUnavailableError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';

export interface CreateProjectInput {
  readonly ownerId: string;
  readonly name: unknown;
  readonly workspaceMode?: unknown;
  readonly objective?: unknown;
}

export class CreateProjectUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly workspaceBoundary: IWorkspaceBoundary,
    private readonly createId: () => string = randomUUID
  ) {}

  public async execute(input: CreateProjectInput): Promise<Project> {
    const identity = normalizeProjectName(input.name);
    const objective = normalizeProjectObjective(input.objective);
    if (input.workspaceMode === 'planning') {
      return this.projectRepository.create({
        id: this.createId(),
        ownerId: input.ownerId,
        name: identity.name,
        slug: identity.slug,
        relativeRoot: null,
        storageKind: null,
        relativeRootKey: null,
        objective
      });
    }
    if (input.workspaceMode !== undefined && input.workspaceMode !== 'file_backed') {
      throw new ProjectWorkspaceModeInvalidError();
    }
    const id = this.createId();
    if (!this.workspaceBoundary.createManagedProjectRoot) throw new WorkspaceStorageUnavailableError();
    const relativeRoot = await this.workspaceBoundary.createManagedProjectRoot(input.ownerId, id);
    return this.projectRepository.create({
      id,
      ownerId: input.ownerId,
      name: identity.name,
      slug: identity.slug,
      relativeRoot,
      storageKind: 'managed',
      relativeRootKey: relativeRoot,
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
