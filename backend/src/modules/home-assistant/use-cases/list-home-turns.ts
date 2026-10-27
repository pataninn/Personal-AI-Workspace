import type { HomeTurnPage } from '@/modules/home-assistant/domain/home-conversation-types';
import { HomeConversationNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';

export interface ListHomeTurnsQuery {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly limit: number;
  readonly afterSequence?: number;
}

/** Lists turns in stable per-conversation creation order. */
export class ListHomeTurnsUseCase {
  public constructor(private readonly conversations: IHomeConversationRepository) {}

  public async execute(input: ListHomeTurnsQuery): Promise<HomeTurnPage> {
    const page = await this.conversations.listTurnsForOwner(input);
    if (!page) throw new HomeConversationNotFoundError();
    return page;
  }
}
