import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { ProjectFactNotFoundError, ProjectFactVersionConflictError } from '@/modules/memory/domain/project-fact-errors';
import { validateExpectedVersion } from '@/modules/memory/domain/project-fact-validation';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import { assertWritableProject } from '@/modules/memory/use-cases/assert-writable-project';

export interface DeleteProjectFactInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly factId: string;
  readonly expectedVersion: unknown;
}

export class DeleteProjectFactUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly factRepository: IProjectFactRepository
  ) {}

  public async execute(input: DeleteProjectFactInput): Promise<void> {
    await assertWritableProject(this.projectRepository, input.ownerId, input.projectId);
    const record = { ...input, expectedVersion: validateExpectedVersion(input.expectedVersion) };
    if (await this.factRepository.softDelete(record)) {
      return;
    }
    if (!await this.factRepository.findActiveById(input.ownerId, input.projectId, input.factId)) {
      throw new ProjectFactNotFoundError();
    }
    throw new ProjectFactVersionConflictError();
  }
}
