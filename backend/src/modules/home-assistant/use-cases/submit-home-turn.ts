import { HomeConversationInputInvalidError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeTurnSubmission } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import { assertHomeIdempotencyKey, homeRequestFingerprint } from '@/modules/home-assistant/use-cases/home-conversation-command-helpers';

export interface SubmitHomeTurnCommand {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly requestKey: string;
  readonly message: string;
}

/** Saves a user turn and reports the current absence of a Home planning runtime honestly. */
export class SubmitHomeTurnUseCase {
  public constructor(private readonly conversations: IHomeConversationRepository) {}

  public async execute(input: SubmitHomeTurnCommand): Promise<HomeTurnSubmission> {
    assertHomeIdempotencyKey(input.requestKey);
    if (input.message.trim().length === 0 || input.message.length > 20000) {
      throw new HomeConversationInputInvalidError('The message must be non-empty and no longer than 20000 characters.');
    }
    return this.conversations.submitTurn({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      requestKey: input.requestKey,
      requestFingerprint: homeRequestFingerprint({ message: input.message }),
      message: input.message,
      initialStatus: 'unsupported'
    });
  }
}
