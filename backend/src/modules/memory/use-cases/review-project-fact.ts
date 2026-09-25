import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { ProjectFactNotFoundError, ProjectFactVersionConflictError } from '@/modules/memory/domain/project-fact-errors';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import { validateExpectedVersion } from '@/modules/memory/domain/project-fact-validation';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import { assertWritableProject } from '@/modules/memory/use-cases/assert-writable-project';

export interface ReviewProjectFactInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly factId: string;
  readonly expectedVersion: unknown;
}

export class ReviewProjectFactUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly factRepository: IProjectFactRepository
  ) {}

  public async execute(input: ReviewProjectFactInput): Promise<ProjectFact> {
    await assertWritableProject(this.projectRepository, input.ownerId, input.projectId);
    const fact = await this.factRepository.verify({ ...input, expectedVersion: validateExpectedVersion(input.expectedVersion) });
    if (fact) {
      return fact;
    }
    if (!await this.factRepository.findActiveById(input.ownerId, input.projectId, input.factId)) {
      throw new ProjectFactNotFoundError();
    }
    throw new ProjectFactVersionConflictError();
  }
}
