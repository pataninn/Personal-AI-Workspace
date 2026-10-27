import {
  ProjectNotFoundError,
  ProjectStatusInvalidError,
  ProjectVersionConflictError
} from '@/modules/projects/domain/project-errors';
import {
  assertProjectRootDoesNotOverlap,
  normalizeProjectRoot
} from '@/modules/projects/domain/project-root-policy';
import type { Project, ProjectStatus } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';

export interface UpdateProjectStatusInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly status: unknown;
  readonly expectedVersion: number;
}

function parseStatus(status: unknown): ProjectStatus {
  if (status === 'active' || status === 'archived') {
    return status;
  }
  throw new ProjectStatusInvalidError();
}

export class UpdateProjectStatusUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly workspaceBoundary: IWorkspaceBoundary
  ) {}

  public async execute(input: UpdateProjectStatusInput): Promise<Project> {
    const status = parseStatus(input.status);
    const existing = await this.projectRepository.findByIdForOwner(input.ownerId, input.projectId);
    if (!existing) {
      throw new ProjectNotFoundError();
    }
    if (existing.version !== input.expectedVersion) {
      throw new ProjectVersionConflictError();
    }
    if (existing.relativeRoot !== null) await this.workspaceBoundary.assertReady();
    if (status === 'active' && existing.status !== 'active' && existing.relativeRoot !== null) {
      const normalizedRoot = normalizeProjectRoot(existing.relativeRoot);
      const validatedRoot = await this.workspaceBoundary.validateProjectRoot(normalizedRoot);
      const activeRoots = await this.projectRepository.listActiveRoots(input.ownerId, existing.storageKind);
      assertProjectRootDoesNotOverlap(validatedRoot, activeRoots);
    }
    const updated = await this.projectRepository.updateStatus({
      ownerId: input.ownerId,
      projectId: input.projectId,
      status,
      expectedVersion: input.expectedVersion
    });
    if (!updated) {
      throw new ProjectVersionConflictError();
    }
    return updated;
  }
}
