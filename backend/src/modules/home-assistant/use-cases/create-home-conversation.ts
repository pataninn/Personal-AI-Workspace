import type { HomeConversation, HomeConversationScope, PersistedHomeResource } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import { assertHomeIdempotencyKey, homeRequestFingerprint } from '@/modules/home-assistant/use-cases/home-conversation-command-helpers';
import { HomeConversationInputInvalidError } from '@/modules/home-assistant/domain/home-conversation-errors';

export interface CreateHomeConversationCommand {
  readonly ownerId: string;
  readonly scope: HomeConversationScope;
  readonly title: string;
  readonly requestKey: string;
}

/** Creates an owner-owned Home or active planning-workspace conversation. */
export class CreateHomeConversationUseCase {
  public constructor(private readonly conversations: IHomeConversationRepository) {}

  public async execute(input: CreateHomeConversationCommand): Promise<PersistedHomeResource<HomeConversation>> {
    return this.create(input, false);
  }

  /** Trusted scheduler-only entry point; the public Home router uses execute. */
  public async executeForAutomation(input: CreateHomeConversationCommand): Promise<PersistedHomeResource<HomeConversation>> {
    return this.create(input, true);
  }

  private async create(input: CreateHomeConversationCommand, forAutomation: boolean): Promise<PersistedHomeResource<HomeConversation>> {
    assertHomeIdempotencyKey(input.requestKey);
    const title = input.title.trim();
    if (title.length < 1 || title.length > 160) throw new HomeConversationInputInvalidError('The conversation title must be 1 to 160 characters.');
    const scope = input.scope.kind === 'home' ? { kind: 'home' as const } : { kind: 'workspace' as const, workspaceId: input.scope.workspaceId };
    const createInput = {
      ownerId: input.ownerId,
      scope,
      title,
      requestKey: input.requestKey,
      requestFingerprint: homeRequestFingerprint({ scope, title })
    };
    return forAutomation
      ? this.conversations.createForAutomation(createInput)
      : this.conversations.create(createInput);
  }
}
