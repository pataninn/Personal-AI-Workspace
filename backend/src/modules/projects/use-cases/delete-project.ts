import type { IProjectRemovalRepository, RemoveProjectRecord } from '@/modules/projects/repositories/project-removal-repository';

/** Permanently removes project-owned application data and private recovery history. */
export class DeleteProjectUseCase {
  public constructor(private readonly repository: IProjectRemovalRepository) {}

  public async execute(input: RemoveProjectRecord): Promise<void> {
    await this.repository.remove(input);
  }
}
