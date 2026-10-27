import type { IProjectRemovalRepository, RemoveProjectRecord } from '@/modules/projects/repositories/project-removal-repository';
import type { CancelHomeTurnUseCase } from '@/modules/home-assistant/use-cases/cancel-home-turn';

/** Permanently removes project-owned application data and private recovery history. */
export class DeleteProjectUseCase {
  public constructor(private readonly repository: IProjectRemovalRepository, private readonly cancelHomeTurn?: CancelHomeTurnUseCase) {}

  public async execute(input: RemoveProjectRecord): Promise<void> {
    await this.repository.remove(input, this.cancelHomeTurn ? async (turn) => {
      const result = await this.cancelHomeTurn?.execute({ ownerId: turn.ownerId, conversationId: turn.conversationId, turnId: turn.turnId });
      return result?.resource.status ?? 'unknown';
    } : undefined);
  }
}
