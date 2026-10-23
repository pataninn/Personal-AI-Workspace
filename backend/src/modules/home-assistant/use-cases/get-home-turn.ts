import { HomeConversationNotFoundError, HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomeTurnIdentity } from '@/modules/home-assistant/use-cases/home-turn-executor';

/** Reads saved progress without advancing the runtime or executing tools. */
export class GetHomeTurnUseCase {
  public constructor(private readonly conversations: IHomeConversationRepository) {}

  public async execute(input: HomeTurnIdentity): Promise<HomeTurn> {
    if (!await this.conversations.findForOwner(input.ownerId, input.conversationId)) throw new HomeConversationNotFoundError();
    const turn = await this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId);
    if (!turn) throw new HomeTurnNotFoundError();
    return turn;
  }
}
