import { HomeConversationNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeConversationEventPage } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';

/** Replays the durable event feed in per-conversation commit order. */
export class ListHomeEventsUseCase {
  public constructor(private readonly conversations: IHomeConversationRepository) {}

  public async execute(input: { readonly ownerId: string; readonly conversationId: string; readonly afterSequence: number; readonly limit: number }): Promise<HomeConversationEventPage> {
    const page = await this.conversations.listEventsForOwner(input);
    if (!page) throw new HomeConversationNotFoundError();
    return page;
  }
}
