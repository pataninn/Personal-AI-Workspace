import { HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeTurn, PersistedHomeResource } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';

/** Persists cancellation intent under the conversation lock before a runtime can be signalled. */
export class CancelHomeTurnUseCase {
  public constructor(private readonly conversations: IHomeConversationRepository) {}

  public async execute(input: { readonly ownerId: string; readonly conversationId: string; readonly turnId: string }): Promise<PersistedHomeResource<HomeTurn>> {
    const result = await this.conversations.cancelTurn(input);
    if (!result) throw new HomeTurnNotFoundError();
    return result;
  }
}
