import { HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeTurn, PersistedHomeResource } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';

/** Persists cancellation intent under the conversation lock before a runtime can be signalled. */
export class CancelHomeTurnUseCase {
  public constructor(private readonly conversations: IHomeConversationRepository, private readonly runtime?: IHomePlanningRuntime) {}

  public async execute(input: { readonly ownerId: string; readonly conversationId: string; readonly turnId: string }): Promise<PersistedHomeResource<HomeTurn>> {
    let result = await this.conversations.cancelTurn(input);
    if (!result) throw new HomeTurnNotFoundError();
    if (!result.replayed && result.resource.status === 'cancel_requested') {
      let confirmed = false;
      try {
        confirmed = (await this.runtime?.cancel(input.turnId))?.outcome === 'confirmed';
      } catch {
        confirmed = false;
      }
      const resource = await this.conversations.updateTurnStatus({
        ...input,
        status: confirmed ? 'cancelled' : 'unknown'
      });
      if (!resource) throw new HomeTurnNotFoundError();
      result = { resource, replayed: false };
    }
    return result;
  }

  /** Drains a fenced, expired owner's runtime without requiring an active-principal write. */
  public async cancelForExpiry(input: { readonly ownerId: string; readonly conversationId: string; readonly turnId: string }): Promise<{ readonly status: HomeTurn['status'] }> {
    const turn = await this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId);
    if (!turn || !this.runtime) return { status: 'unknown' };
    try {
      if (['completed', 'partial', 'failed', 'cancelled', 'unsupported'].includes(turn.status)) {
        await this.runtime.delete(input.turnId);
        return { status: turn.status };
      }
      if ((await this.runtime.cancel(input.turnId)).outcome !== 'confirmed') return { status: 'unknown' };
      await this.runtime.delete(input.turnId);
      return { status: 'cancelled' };
    } catch {
      return { status: 'unknown' };
    }
  }
}
