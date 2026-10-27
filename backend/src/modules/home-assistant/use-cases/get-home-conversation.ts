import { HomeConversationNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeConversation } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';

/** Reads only a conversation owned by the authenticated user. */
export class GetHomeConversationUseCase {
  public constructor(private readonly conversations: IHomeConversationRepository) {}

  public async execute(input: { readonly ownerId: string; readonly conversationId: string }): Promise<HomeConversation> {
    const conversation = await this.conversations.findForOwner(input.ownerId, input.conversationId);
    if (!conversation) throw new HomeConversationNotFoundError();
    return conversation;
  }
}
