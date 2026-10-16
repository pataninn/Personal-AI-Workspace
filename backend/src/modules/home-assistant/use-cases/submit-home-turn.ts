import { randomUUID } from 'node:crypto';

import { HomeConversationInputInvalidError, HomeConversationNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeConsentDisclosureDraft, HomeTurnSubmission } from '@/modules/home-assistant/domain/home-conversation-types';
import { HOME_PLANNING_CONTEXT_LIMITS } from '@/modules/home-assistant/domain/home-planning-context';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomePlanningProvider, IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import { assertHomeIdempotencyKey, homeRequestFingerprint } from '@/modules/home-assistant/use-cases/home-conversation-command-helpers';
import { redactEgressText } from '@/shared/egress/redaction';

const MAX_INITIAL_PROMPT_BYTES = HOME_PLANNING_CONTEXT_LIMITS.promptBytes;

export interface HomeTurnRuntimeConfiguration {
  readonly mode: 'fake' | 'direct' | 'openshell' | 'hermes';
  readonly runtime?: IHomePlanningRuntime;
  readonly provider: HomePlanningProvider;
}

export interface SubmitHomeTurnCommand {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly requestKey: string;
  readonly message: string;
}

/** Saves a user turn and reports the current absence of a Home planning runtime honestly. */
export class SubmitHomeTurnUseCase {
  public constructor(
    private readonly conversations: IHomeConversationRepository,
    private readonly runtimeConfiguration?: HomeTurnRuntimeConfiguration
  ) {}

  public async execute(input: SubmitHomeTurnCommand): Promise<HomeTurnSubmission> {
    assertHomeIdempotencyKey(input.requestKey);
    if (input.message.trim().length === 0 || input.message.length > 20000) {
      throw new HomeConversationInputInvalidError('The message must be non-empty and no longer than 20000 characters.');
    }
    const provider = this.runtimeConfiguration?.mode === 'hermes' ? this.runtimeConfiguration.provider : undefined;
    const runtime = this.runtimeConfiguration?.mode === 'hermes' ? this.runtimeConfiguration.runtime : undefined;
    const conversation = provider && runtime ? await this.conversations.findForOwner(input.ownerId, input.conversationId) : null;
    if (provider && runtime && !conversation) {
      throw new HomeConversationNotFoundError();
    }
    const redacted = redactEgressText(input.message);
    if (Buffer.byteLength(redacted, 'utf8') > MAX_INITIAL_PROMPT_BYTES) {
      throw new HomeConversationInputInvalidError('The redacted message exceeds the provider request limit.');
    }
    const initialDisclosure: HomeConsentDisclosureDraft | undefined = provider && runtime && conversation
      ? {
        disclosureId: randomUUID(),
        phase: 'initial',
        provider: { profile: provider.profile, name: providerDisplayName(provider.profile), model: provider.model },
        scope: conversation.scope,
        categories: ['current_message'],
        itemCount: 1,
        byteLimit: MAX_INITIAL_PROMPT_BYTES
      }
      : undefined;
    return this.conversations.submitTurn({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      requestKey: input.requestKey,
      requestFingerprint: homeRequestFingerprint({ message: input.message }),
      message: input.message,
      initialStatus: initialDisclosure ? 'pending' : 'unsupported',
      ...(initialDisclosure ? { initialDisclosure } : {})
    });
  }
}

function providerDisplayName(profile: string): string {
  if (profile === 'nebius-token-factory') return 'Nebius Token Factory';
  if (profile === 'nvidia-hosted-nim') return 'NVIDIA hosted NIM';
  return profile;
}
