import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { ProjectFactNotFoundError, ProjectFactVersionConflictError } from '@/modules/memory/domain/project-fact-errors';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import { validateExpectedVersion, validateProjectFactDraft } from '@/modules/memory/domain/project-fact-validation';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import { assertWritableProject } from '@/modules/memory/use-cases/assert-writable-project';

export interface UpdateProjectFactInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly factId: string;
  readonly title: unknown;
  readonly content: unknown;
  readonly expectedVersion: unknown;
}

export class UpdateProjectFactUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly factRepository: IProjectFactRepository
  ) {}

  public async execute(input: UpdateProjectFactInput): Promise<ProjectFact> {
    await assertWritableProject(this.projectRepository, input.ownerId, input.projectId);
    const expectedVersion = validateExpectedVersion(input.expectedVersion);
    const draft = validateProjectFactDraft(input.title, input.content);
    const updated = await this.factRepository.update({ ...input, ...draft, expectedVersion });
    if (updated) {
      return updated;
    }
    if (!await this.factRepository.findActiveById(input.ownerId, input.projectId, input.factId)) {
      throw new ProjectFactNotFoundError();
    }
    throw new ProjectFactVersionConflictError();
  }
}
