import type { AssertAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import type { HomeConversationScope, HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import { HomeConversationNotFoundError, HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomePlanningProvider, HomePlanningRuntimeEvent, IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import type { HomeToolResultConsentGate } from '@/modules/home-assistant/use-cases/home-tool-result-consent-gate';
import type { IHomePlanningToolRequestHandler } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';
import type { HomeAutomationFence } from '@/modules/home-assistant/repositories/home-conversation-repository';
import { redactEgressText } from '@/shared/egress/redaction';

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

export interface HomeTurnPolicyConfiguration {
  readonly executionPolicy: Pick<AssertAssistantExecutionPolicyUseCase, 'assertHome'>;
  readonly providerProfile: string;
  readonly model: string;
}

export interface TrustedScheduledTurnGuard {
  readonly fence: HomeAutomationFence;
  isCurrent(): Promise<boolean>;
}

/** Reads a Home turn only when its persisted policy binding remains current. */
export class GetHomeTurnUseCase {
  private readonly pollStates = new Map<string, RuntimePollState>();
  private readonly activePolls = new Map<string, Promise<void>>();

  public constructor(
    private readonly conversations: IHomeConversationRepository,
    private readonly runtime?: IHomePlanningRuntime,
    // Retained only as a positional compatibility slot; no consent result may continue a runtime.
    _legacyConsentGate?: HomeToolResultConsentGate,
    private readonly toolRequestHandler?: IHomePlanningToolRequestHandler,
    private readonly policyConfiguration?: HomeTurnPolicyConfiguration
  ) {}

  public async execute(input: { readonly ownerId: string; readonly conversationId: string; readonly turnId: string; readonly automationGuard?: TrustedScheduledTurnGuard }): Promise<HomeTurn> {
    const conversation = await this.conversations.findForOwner(input.ownerId, input.conversationId);
    if (!conversation) throw new HomeConversationNotFoundError();
    const turn = await this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId);
    if (!turn) throw new HomeTurnNotFoundError();
    if (turn.automationOccurrenceId && input.automationGuard?.fence.occurrenceId !== turn.automationOccurrenceId) return turn;
    if (input.automationGuard && turn.automationOccurrenceId !== input.automationGuard.fence.occurrenceId) return turn;

    if (!hasPolicyBinding(turn, conversation.scope)) {
      return this.blockLegacyTurn(turn, input.ownerId, input.conversationId, input.automationGuard);
    }
    if (turn.status === 'running' || turn.status === 'unknown' && input.automationGuard !== undefined) {
      if (this.runtime) await this.pollRuntime(turn, input.ownerId, input.conversationId, conversation.scope, input.automationGuard);
      else if (turn.status === 'running') return await this.blockActiveTurn(turn, input.ownerId, input.conversationId, input.automationGuard);
    } else if (this.pollStates.get(turn.id)?.cleanupPending) {
      await this.retryCleanup(turn.id);
    }
    return await this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId) ?? turn;
  }

  private async blockLegacyTurn(turn: HomeTurn, ownerId: string, conversationId: string, guard?: TrustedScheduledTurnGuard): Promise<HomeTurn> {
    if (turn.status === 'pending') return await this.updateStatus(ownerId, conversationId, turn.id, 'unsupported') ?? turn;
    if (turn.status === 'running' || turn.status === 'cancel_requested') {
      return await this.stopRuntimeAndMark(turn, ownerId, conversationId, guard);
    }
    return turn;
  }

  private async blockActiveTurn(turn: HomeTurn, ownerId: string, conversationId: string, guard?: TrustedScheduledTurnGuard): Promise<HomeTurn> {
    return await this.stopRuntimeAndMark(turn, ownerId, conversationId, guard);
  }

  private async pollRuntime(turn: HomeTurn, ownerId: string, conversationId: string, scope: HomeConversationScope, guard?: TrustedScheduledTurnGuard): Promise<void> {
    const current = this.activePolls.get(turn.id);
    if (current) return current;
    const polling = this.readRuntime(turn, ownerId, conversationId, scope, guard);
    this.activePolls.set(turn.id, polling);
    try {
      await polling;
    } finally {
      this.activePolls.delete(turn.id);
    }
  }

  private async readRuntime(turn: HomeTurn, ownerId: string, conversationId: string, scope: HomeConversationScope, guard?: TrustedScheduledTurnGuard): Promise<void> {
    const state = this.pollStates.get(turn.id) ?? newPollState();
    this.pollStates.set(turn.id, state);
    for (let pageIndex = 0; pageIndex < MAX_POLL_PAGES_PER_READ; pageIndex += 1) {
      if (!await this.isAuthorized(turn, ownerId, conversationId, scope, undefined, guard)) {
        await this.stopRuntimeAndMark(turn, ownerId, conversationId, guard);
        return;
      }
      let page: Awaited<ReturnType<IHomePlanningRuntime['poll']>> | undefined;
      try {
        page = await this.runtime?.poll({ turnId: turn.id, cursor: state.cursor });
      } catch {
        page = undefined;
      }
      if (!page) {
        await this.updateStatus(ownerId, conversationId, turn.id, 'unknown');
        await this.clearRuntime(turn.id);
        return;
      }
      if (page.status === 'unknown') {
        await this.updateStatus(ownerId, conversationId, turn.id, 'unknown');
        await this.clearRuntime(turn.id);
        return;
      }
      const recorded = await this.recordRuntimeEvents(turn, ownerId, conversationId, scope, state, page.events, guard);
      if (recorded === 'invalid') {
        await this.updateStatus(ownerId, conversationId, turn.id, 'unknown');
        await this.clearRuntime(turn.id);
        return;
      }
      if (recorded === 'blocked') {
        await this.stopRuntimeAndMark(turn, ownerId, conversationId, guard);
        return;
      }
      if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < state.cursor || page.nextCursor < state.lastEventSequence
        || (page.hasMore && page.nextCursor === state.cursor)) {
        await this.updateStatus(ownerId, conversationId, turn.id, 'unknown');
        await this.clearRuntime(turn.id);
        return;
      }
      state.cursor = page.nextCursor;
      if (page.status === 'completed') {
        if (page.hasMore) continue;
        if (!await this.isAuthorized(turn, ownerId, conversationId, scope, undefined, guard)) {
          await this.stopRuntimeAndMark(turn, ownerId, conversationId, guard);
          return;
        }
        const completed = await this.conversations.completeTurnWithAssistant({
          ownerId,
          conversationId,
          turnId: turn.id,
          content: state.output,
          status: state.truncated ? 'partial' : 'completed',
          ...(guard ? { automationFence: guard.fence } : {})
        });
        if (!completed) await this.stopRuntimeAndMark(turn, ownerId, conversationId, guard);
        if (completed && ['completed', 'partial'].includes(completed.status)) await this.deleteTerminalRuntime(turn.id);
        return;
      }
      if (page.status === 'failed' || page.status === 'cancelled') {
        const updated = await this.updateStatus(ownerId, conversationId, turn.id, page.status);
        if (updated && ['failed', 'cancelled'].includes(updated.status)) await this.deleteTerminalRuntime(turn.id);
        return;
      }
      if (!page.hasMore) return;
    }
  }

  private async isAuthorized(turn: HomeTurn, ownerId: string, conversationId: string, scope: HomeConversationScope, projectId?: string, guard?: TrustedScheduledTurnGuard): Promise<boolean> {
    if (!this.runtime || !this.policyConfiguration || !hasPolicyBinding(turn, scope)) return false;
    const current = await this.conversations.findTurnForOwner(ownerId, conversationId, turn.id);
    if (!current || current.status !== 'running' && !(guard && current.status === 'unknown') || !sameBinding(current, turn)) return false;
    if (turn.automationOccurrenceId && (!guard || turn.automationOccurrenceId !== guard.fence.occurrenceId || !await guard.isCurrent())) return false;
    try {
      if (!this.runtime.supportsPolicyExecution || !await this.runtime.supportsPolicyExecution({
        providerProfile: this.policyConfiguration.providerProfile,
        model: this.policyConfiguration.model
      })) return false;
      const expectedHomeRevision = turn.homePolicyRevision;
      if (!isRevision(expectedHomeRevision)) return false;
      const expectedWorkspaceRevision = scope.kind === 'workspace' ? turn.workspacePolicyRevision : null;
      if (scope.kind === 'workspace' && !isRevision(expectedWorkspaceRevision)) return false;
      if (scope.kind === 'workspace' && projectId !== undefined && projectId !== scope.workspaceId) return false;
      await this.policyConfiguration.executionPolicy.assertHome({
        ownerId,
        ...(projectId ? { projectId } : scope.kind === 'workspace' ? { projectId: scope.workspaceId } : {}),
        providerProfile: this.policyConfiguration.providerProfile,
        model: this.policyConfiguration.model,
        homePolicyRevision: expectedHomeRevision,
        ...(scope.kind === 'workspace' && isRevision(expectedWorkspaceRevision) ? { workspacePolicyRevision: expectedWorkspaceRevision } : {})
      });
      return true;
    } catch {
      return false;
    }
  }

  private async recordRuntimeEvents(
    turn: HomeTurn,
    ownerId: string,
    conversationId: string,
    scope: HomeConversationScope,
    state: RuntimePollState,
    events: readonly HomePlanningRuntimeEvent[],
    guard?: TrustedScheduledTurnGuard
  ): Promise<'ok' | 'blocked' | 'invalid'> {
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
        if (turn.status === 'unknown' && guard) return 'blocked';
        if (index !== events.length - 1 || !this.toolRequestHandler
          || !await this.isAuthorized(turn, ownerId, conversationId, scope, undefined, guard)) return 'blocked';
        let candidate;
        try {
          candidate = await this.toolRequestHandler.resolve({
            ownerId, conversationId, turnId: turn.id, requestId: event.requestId, name: event.name, args: event.args, scope
          });
        } catch {
          return 'blocked';
        }
        if (!candidate || candidate.kind !== 'immediate') return 'blocked';
        const targetProjectId = candidate.authorizationProjectId;
        if (scope.kind === 'workspace' && targetProjectId !== undefined && targetProjectId !== scope.workspaceId) return 'blocked';
        if (!await this.isAuthorized(turn, ownerId, conversationId, scope, targetProjectId, guard)) return 'blocked';
        try {
          const sent = await this.runtime?.sendToolResult({ turnId: turn.id, requestId: event.requestId, result: candidate.result });
          if (!sent?.accepted) return 'blocked';
        } catch {
          return 'blocked';
        }
      }
    }
    state.lastEventSequence = lastSequence;
    return 'ok';
  }

  private async stopRuntimeAndMark(turn: HomeTurn, ownerId: string, conversationId: string, _guard?: TrustedScheduledTurnGuard): Promise<HomeTurn> {
    let cancelled = false;
    try {
      cancelled = (await this.runtime?.cancel(turn.id))?.outcome === 'confirmed';
    } catch {
      cancelled = false;
    }
    const current = await this.conversations.findTurnForOwner(ownerId, conversationId, turn.id);
    if (!current) throw new HomeTurnNotFoundError();
    if (current.status !== 'running' && current.status !== 'cancel_requested') return current;
    const updated = await this.updateStatus(ownerId, conversationId, turn.id, cancelled ? 'cancelled' : 'unknown');
    if (cancelled) await this.deleteTerminalRuntime(turn.id);
    return updated ?? current;
  }

  private async updateStatus(ownerId: string, conversationId: string, turnId: string, status: 'failed' | 'cancelled' | 'unknown' | 'unsupported'): Promise<HomeTurn | null> {
    return this.conversations.updateTurnStatus({ ownerId, conversationId, turnId, status });
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

function hasPolicyBinding(turn: HomeTurn, scope: HomeConversationScope): boolean {
  return isRevision(turn.homePolicyRevision)
    && (scope.kind === 'home'
      ? turn.workspacePolicyRevision === null
      : isRevision(turn.workspacePolicyRevision));
}

function sameBinding(left: HomeTurn, right: HomeTurn): boolean {
  return left.homePolicyRevision === right.homePolicyRevision
    && left.workspacePolicyRevision === right.workspacePolicyRevision
    && (left.skillInvocationId ?? null) === (right.skillInvocationId ?? null)
    && (left.automationOccurrenceId ?? null) === (right.automationOccurrenceId ?? null);
}

function isRevision(value: string | null): value is string {
  return value !== null && /^[1-9][0-9]{0,18}$/u.test(value);
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
