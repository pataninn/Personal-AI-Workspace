import { HomeConversationNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeMessagePage } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';

/** Lists messages in an owner-owned Home conversation. */
export class ListHomeMessagesUseCase {
  public constructor(private readonly conversations: IHomeConversationRepository) {}

  public async execute(input: { readonly ownerId: string; readonly conversationId: string; readonly limit: number; readonly beforeSequence?: number }): Promise<HomeMessagePage> {
    const page = await this.conversations.listMessagesForOwner(input);
    if (!page) throw new HomeConversationNotFoundError();
    return page;
  }
}
