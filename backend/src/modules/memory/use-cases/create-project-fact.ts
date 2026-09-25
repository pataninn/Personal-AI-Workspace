import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import { validateProjectFactDraft } from '@/modules/memory/domain/project-fact-validation';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import { assertWritableProject } from '@/modules/memory/use-cases/assert-writable-project';

export interface CreateProjectFactInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly title: unknown;
  readonly content: unknown;
}

export class CreateProjectFactUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly factRepository: IProjectFactRepository
  ) {}

  public async execute(input: CreateProjectFactInput): Promise<ProjectFact> {
    await assertWritableProject(this.projectRepository, input.ownerId, input.projectId);
    const draft = validateProjectFactDraft(input.title, input.content);
    return this.factRepository.create({
      ownerId: input.ownerId,
      projectId: input.projectId,
      ...draft
    });
  }
}
