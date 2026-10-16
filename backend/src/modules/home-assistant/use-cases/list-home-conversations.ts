import type { HomeConversationPage, HomeConversationScope } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';

export interface ListHomeConversationsQuery {
  readonly ownerId: string;
  readonly scope: HomeConversationScope;
  readonly limit: number;
  readonly cursor?: string;
}

/** Lists history in one authenticated Home or workspace scope. */
export class ListHomeConversationsUseCase {
  public constructor(private readonly conversations: IHomeConversationRepository) {}

  public execute(input: ListHomeConversationsQuery): Promise<HomeConversationPage> {
    return this.conversations.listForOwner(input);
  }
}
