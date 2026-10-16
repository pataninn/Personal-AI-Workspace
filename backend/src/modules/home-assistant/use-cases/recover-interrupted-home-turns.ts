import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';

/** Marks work left active by a prior process as unknown; it never replays writes. */
export class RecoverInterruptedHomeTurnsUseCase {
  public constructor(private readonly conversations: IHomeConversationRepository) {}

  public execute(): Promise<number> {
    return this.conversations.reconcileInterruptedTurns();
  }
}
