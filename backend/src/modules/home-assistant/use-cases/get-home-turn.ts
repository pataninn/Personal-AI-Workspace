import { HomeConversationNotFoundError, HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomePlanningRuntimeEvent, IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import { redactEgressText } from '@/shared/egress/redaction';
import type { HomeToolResultConsentGate } from '@/modules/home-assistant/use-cases/home-tool-result-consent-gate';
import type { IHomePlanningToolRequestHandler } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';

const MAX_RUNTIME_EVENTS = 2000;
const MAX_RUNTIME_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_ASSISTANT_BYTES = 256 * 1024;
const MAX_POLL_PAGES_PER_READ = 8;

interface RuntimePollState {
  cursor: number;
  lastEventSequence: number;
  events: number;
  historyBytes: number;
  outputBytes: number;
  output: string;
  truncated: boolean;
  cleanupPending: boolean;
}

/** Reads a Home turn only when both its conversation and authenticated owner match. */
export class GetHomeTurnUseCase {
  private readonly pollStates = new Map<string, RuntimePollState>();
  private readonly activePolls = new Map<string, Promise<void>>();

  public constructor(
    private readonly conversations: IHomeConversationRepository,
    private readonly runtime?: IHomePlanningRuntime,
    private readonly toolResults?: HomeToolResultConsentGate,
    private readonly toolRequestHandler?: IHomePlanningToolRequestHandler
  ) {}

  public async execute(input: { readonly ownerId: string; readonly conversationId: string; readonly turnId: string }): Promise<HomeTurn> {
    const conversation = await this.conversations.findForOwner(input.ownerId, input.conversationId);
    if (!conversation) throw new HomeConversationNotFoundError();
    const turn = await this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId);
    if (!turn) throw new HomeTurnNotFoundError();
    if (this.runtime && turn.status === 'running') await this.pollRuntime(turn.id, input.ownerId, input.conversationId, conversation.scope);
    else if (this.runtime && this.pollStates.get(turn.id)?.cleanupPending) await this.retryCleanup(turn.id);
    return await this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId) ?? turn;
  }

  private async pollRuntime(turnId: string, ownerId: string, conversationId: string, scope: NonNullable<Awaited<ReturnType<IHomeConversationRepository['findForOwner']>>>['scope']): Promise<void> {
    const current = this.activePolls.get(turnId);
    if (current) return current;
    const polling = this.readRuntime(turnId, ownerId, conversationId, scope);
    this.activePolls.set(turnId, polling);
    try {
      await polling;
    } finally {
      this.activePolls.delete(turnId);
    }
  }

  private async readRuntime(turnId: string, ownerId: string, conversationId: string, scope: NonNullable<Awaited<ReturnType<IHomeConversationRepository['findForOwner']>>>['scope']): Promise<void> {
    const state = this.pollStates.get(turnId) ?? newPollState();
    this.pollStates.set(turnId, state);
    for (let pageIndex = 0; pageIndex < MAX_POLL_PAGES_PER_READ; pageIndex += 1) {
      let page: Awaited<ReturnType<IHomePlanningRuntime['poll']>> | undefined;
      try {
        page = await this.runtime?.poll({ turnId, cursor: state.cursor });
      } catch {
        page = undefined;
      }
      if (!page) {
        await this.updateStatus(ownerId, conversationId, turnId, 'unknown');
        await this.clearRuntime(turnId);
        return;
      }
      if (page.status === 'unknown') {
        await this.updateStatus(ownerId, conversationId, turnId, 'unknown');
        await this.clearRuntime(turnId);
        return;
      }
      const recorded = await this.recordRuntimeEvents(ownerId, conversationId, turnId, scope, state, page.events);
      if (recorded === 'invalid') {
        await this.updateStatus(ownerId, conversationId, turnId, 'unknown');
        await this.clearRuntime(turnId);
        return;
      }
      if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < state.cursor || page.nextCursor < state.lastEventSequence
        || (page.hasMore && page.nextCursor === state.cursor)) {
        await this.updateStatus(ownerId, conversationId, turnId, 'unknown');
        await this.clearRuntime(turnId);
        return;
      }
      state.cursor = page.nextCursor;
      if (recorded === 'consent-required') {
        if (page.status === 'cancelled' || page.status === 'failed') {
          const turn = await this.updateStatus(ownerId, conversationId, turnId, page.status);
          if (turn && ['failed', 'cancelled'].includes(turn.status)) await this.deleteTerminalRuntime(turnId);
        } else if (page.status === 'completed') {
          await this.updateStatus(ownerId, conversationId, turnId, 'unknown');
          await this.clearRuntime(turnId);
        }
        return;
      }
      if (page.status === 'completed') {
        if (page.hasMore) continue;
        const turn = await this.conversations.completeTurnWithAssistant({
          ownerId,
          conversationId,
          turnId,
          content: state.output,
          status: state.truncated ? 'partial' : 'completed'
        });
        if (turn && ['completed', 'partial'].includes(turn.status)) await this.deleteTerminalRuntime(turnId);
        return;
      }
      if (page.status === 'failed' || page.status === 'cancelled') {
        const turn = await this.updateStatus(ownerId, conversationId, turnId, page.status);
        if (turn && ['failed', 'cancelled'].includes(turn.status)) await this.deleteTerminalRuntime(turnId);
        return;
      }
      if (!page.hasMore) return;
    }
  }

  private async updateStatus(ownerId: string, conversationId: string, turnId: string, status: 'failed' | 'cancelled' | 'unknown'): Promise<HomeTurn | null> {
    return this.conversations.updateTurnStatus({ ownerId, conversationId, turnId, status });
  }

  private async recordRuntimeEvents(
    ownerId: string,
    conversationId: string,
    turnId: string,
    scope: NonNullable<Awaited<ReturnType<IHomeConversationRepository['findForOwner']>>>['scope'],
    state: RuntimePollState,
    events: readonly HomePlanningRuntimeEvent[]
  ): Promise<'ok' | 'consent-required' | 'invalid'> {
    let lastSequence = state.lastEventSequence;
    for (const [index, event] of events.entries()) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence) return 'invalid';
      lastSequence = event.sequence;
      state.events += 1;
      state.historyBytes += encodedBytes(event);
      if (state.events > MAX_RUNTIME_EVENTS || state.historyBytes > MAX_RUNTIME_HISTORY_BYTES) return 'invalid';
      if (event.type === 'assistant.delta') {
        const text = redactEgressText(event.text);
        const bytes = Buffer.byteLength(text, 'utf8');
        if (state.outputBytes + bytes > MAX_ASSISTANT_BYTES) {
          const room = Math.max(0, MAX_ASSISTANT_BYTES - state.outputBytes);
          state.output += truncateUtf8(text, room);
          state.outputBytes = Buffer.byteLength(state.output, 'utf8');
          state.truncated = true;
        } else {
          state.output += text;
          state.outputBytes += bytes;
        }
      } else if (event.type === 'home.tool.requested') {
        if (this.toolRequestHandler && this.toolResults) {
          if (index !== events.length - 1) return 'invalid';
          try {
            const candidate = await this.toolRequestHandler.resolve({
              ownerId, conversationId, turnId, requestId: event.requestId, name: event.name, args: event.args, scope
            });
            if (candidate) {
              await this.toolResults.request({
                ownerId, conversationId, turnId, requestId: event.requestId,
                scope: candidate.scope, categories: candidate.categories, itemCount: candidate.itemCount, data: candidate.data
              });
              state.lastEventSequence = lastSequence;
              return 'consent-required';
            }
          } catch {
            return 'invalid';
          }
        }
        try {
          const result = await this.runtime?.sendToolResult({ turnId, requestId: event.requestId, result: { outcome: 'denied', code: 'CONSENT_DENIED' } });
          if (!result?.accepted) return 'invalid';
        } catch {
          return 'invalid';
        }
      }
    }
    state.lastEventSequence = lastSequence;
    return 'ok';
  }

  private async deleteTerminalRuntime(turnId: string): Promise<void> {
    if (!this.runtime) return;
    try {
      await this.runtime.delete(turnId);
      this.pollStates.delete(turnId);
    } catch {
      const state = this.pollStates.get(turnId);
      if (state) state.cleanupPending = true;
    }
  }

  private async retryCleanup(turnId: string): Promise<void> {
    if (!this.runtime) return;
    try {
      await this.runtime.delete(turnId);
      this.pollStates.delete(turnId);
    } catch {
      // Retain only the cursor and retry cleanup on the next owner-scoped turn read.
    }
  }

  private async clearRuntime(turnId: string): Promise<void> {
    this.pollStates.delete(turnId);
  }
}

function newPollState(): RuntimePollState {
  return { cursor: 0, lastEventSequence: 0, events: 0, historyBytes: 0, outputBytes: 0, output: '', truncated: false, cleanupPending: false };
}

function encodedBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(encoded, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateUtf8(value: string, byteLimit: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > byteLimit) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
