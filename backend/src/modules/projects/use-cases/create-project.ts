import {
  assertProjectRootDoesNotOverlap,
  normalizeProjectName,
  normalizeProjectRoot,
  projectRootOverlapKey
} from '@/modules/projects/domain/project-root-policy';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';

export interface CreateProjectInput {
  readonly ownerId: string;
  readonly name: unknown;
  readonly relativeRoot: unknown;
}

export class CreateProjectUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly workspaceBoundary: IWorkspaceBoundary
  ) {}

  public async execute(input: CreateProjectInput): Promise<Project> {
    const identity = normalizeProjectName(input.name);
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
      relativeRootKey: projectRootOverlapKey(projectRoot)
    });
  }
}
