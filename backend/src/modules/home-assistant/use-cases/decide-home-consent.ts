import { createHash } from 'node:crypto';

import type { HomeConsentDecisionResult, HomeConversation, HomeMessage, HomeTurn, HomeTurnExecution } from '@/modules/home-assistant/domain/home-conversation-types';
import { HomeConversationNotFoundError, HomePlanningContextTooLargeError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { buildHomePlanningContext, HOME_PLANNING_CONTEXT_LIMITS } from '@/modules/home-assistant/domain/home-planning-context';
import type { HomePlanningContext } from '@/modules/home-assistant/domain/home-planning-context';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomePlanningProvider, IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import type { PendingHomeToolResult, HomeToolResultConsentGate } from '@/modules/home-assistant/use-cases/home-tool-result-consent-gate';

const MAX_INITIAL_PROMPT_BYTES = HOME_PLANNING_CONTEXT_LIMITS.promptBytes;

export interface DecideHomeConsentCommand {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly disclosureId: string;
  readonly decision: 'allow' | 'deny';
}

export interface HomeConsentDecisionResponse extends HomeConsentDecisionResult {
  readonly execution: HomeTurnExecution;
}

/** Applies one-turn consent and starts only the dedicated planning runtime after approval. */
export class DecideHomeConsentUseCase {
  public constructor(
    private readonly conversations: IHomeConversationRepository,
    private readonly runtime?: IHomePlanningRuntime,
    private readonly provider?: HomePlanningProvider,
    private readonly toolResults?: HomeToolResultConsentGate
  ) {}

  public async execute(input: DecideHomeConsentCommand): Promise<HomeConsentDecisionResponse> {
    const result = await this.conversations.decideConsent(input);
    if (!result) throw new HomeConversationNotFoundError();
    if (result.disclosure.phase === 'tool_result') return this.decideToolResult(input, result);
    if (input.decision === 'deny') return { ...result, execution: { state: 'cancelled' } };
    if (result.replayed) return { ...result, execution: replayExecution(result.turn) };
    if (!this.runtime || !this.provider || !matchesProvider(result, this.provider)) {
      return this.finishStart(input, 'unavailable');
    }

    const current = await this.currentStartState(input);
    if (!current) return this.finishStart(input, 'unknown');
    if (current.turn.status !== 'pending' || current.disclosure.deliveryState !== 'starting') {
      return { ...result, turn: current.turn, execution: replayExecution(current.turn) };
    }
    let context: HomePlanningContext;
    try {
      context = buildHomePlanningContext({ currentMessage: current.message.content, priorMessages: current.priorMessages });
    } catch (error: unknown) {
      if (error instanceof HomePlanningContextTooLargeError) return this.finishStart(input, 'unavailable');
      throw error;
    }
    if (!matchesInitialSnapshot(current, context)) {
      return this.finishStart(input, 'unavailable');
    }

    let outcome: 'accepted' | 'unavailable' | 'unknown';
    try {
      const started = await this.runtime.start({ turnId: input.turnId, prompt: context.prompt, provider: this.provider });
      outcome = started.outcome;
    } catch {
      outcome = 'unknown';
    }
    const updatedTurn = await this.conversations.updateConsentDelivery({ ...input, deliveryState: outcome });
    if (!updatedTurn) throw new HomeConversationNotFoundError();
    if (outcome === 'accepted' && updatedTurn.status === 'cancel_requested') {
      return this.cancelAcceptedStart(input, updatedTurn);
    }
    return {
      ...result,
      turn: updatedTurn,
      disclosure: await this.requiredDisclosure(input),
      execution: executionForDelivery(outcome, updatedTurn)
    };
  }

  private async decideToolResult(input: DecideHomeConsentCommand, result: HomeConsentDecisionResult): Promise<HomeConsentDecisionResponse> {
    if (result.replayed) return { ...result, execution: replayToolExecution(result.turn, result.disclosure.deliveryState) };
    const [turn, disclosure] = await Promise.all([
      this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId),
      this.conversations.findConsentDisclosure(input.ownerId, input.conversationId, input.turnId, input.disclosureId)
    ]);
    if (!turn || !disclosure) throw new HomeConversationNotFoundError();
    if (turn.status !== 'running' || disclosure.decision !== input.decision
      || disclosure.deliveryState !== (input.decision === 'allow' ? 'starting' : 'not_required')) {
      return this.finishToolResult(input, 'unknown');
    }
    if (!this.runtime) return this.finishToolResult(input, 'unknown');

    const pending = this.toolResults?.take(input.disclosureId) ?? null;
    if (input.decision === 'allow' && (!pending || !matchesPendingResult(pending, disclosure))) {
      return this.finishToolResult(input, 'unknown');
    }
    const activeTurn = await this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId);
    const currentDisclosure = await this.conversations.findConsentDisclosure(input.ownerId, input.conversationId, input.turnId, input.disclosureId);
    if (!activeTurn || !currentDisclosure || activeTurn.status !== 'running' || currentDisclosure.decision !== input.decision
      || currentDisclosure.runtimeRequestId === null) {
      return this.finishToolResult(input, 'unknown');
    }

    let accepted = false;
    try {
      const sent = await this.runtime.sendToolResult({
        turnId: input.turnId,
        requestId: currentDisclosure.runtimeRequestId ?? '',
        result: input.decision === 'allow' && pending
          ? { outcome: 'shared', data: pending.data }
          : { outcome: 'denied', code: 'CONSENT_DENIED' }
      });
      accepted = sent.accepted;
    } catch {
      accepted = false;
    }
    return this.finishToolResult(input, accepted ? 'accepted' : 'unknown');
  }

  private async finishToolResult(input: DecideHomeConsentCommand, outcome: 'accepted' | 'unknown'): Promise<HomeConsentDecisionResponse> {
    const turn = await this.conversations.updateToolResultDelivery({ ...input, deliveryState: outcome });
    if (!turn) throw new HomeConversationNotFoundError();
    return {
      turn,
      disclosure: await this.requiredDisclosure(input),
      replayed: false,
      execution: outcome === 'accepted' && turn.status === 'running'
        ? { state: 'resumed' }
        : replayExecution(turn)
    };
  }

  private async currentStartState(input: DecideHomeConsentCommand): Promise<{
    readonly turn: HomeTurn;
    readonly disclosure: NonNullable<Awaited<ReturnType<IHomeConversationRepository['findConsentDisclosure']>>>;
    readonly message: NonNullable<Awaited<ReturnType<IHomeConversationRepository['findUserMessageForTurn']>>>;
    readonly conversation: NonNullable<Awaited<ReturnType<IHomeConversationRepository['findForOwner']>>>;
    readonly priorMessages: readonly HomeMessage[];
  } | null> {
    const [turn, disclosure, message, conversation] = await Promise.all([
      this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId),
      this.conversations.findConsentDisclosure(input.ownerId, input.conversationId, input.turnId, input.disclosureId),
      this.conversations.findUserMessageForTurn(input.ownerId, input.conversationId, input.turnId),
      this.conversations.findForOwner(input.ownerId, input.conversationId)
    ]);
    if (!turn || !disclosure || !message || !conversation || disclosure.decision !== 'allow') return null;
    const historyPage = await this.conversations.listMessagesForOwner({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      beforeSequence: message.sequence,
      limit: 8,
      transcriptOnly: true
    });
    if (!historyPage) return null;
    return { turn, disclosure, message, conversation, priorMessages: historyPage.messages };
  }

  private async finishStart(input: DecideHomeConsentCommand, outcome: 'unavailable' | 'unknown'): Promise<HomeConsentDecisionResponse> {
    const turn = await this.conversations.updateConsentDelivery({ ...input, deliveryState: outcome });
    if (!turn) throw new HomeConversationNotFoundError();
    return {
      turn,
      disclosure: await this.requiredDisclosure(input),
      replayed: false,
      execution: executionForDelivery(outcome, turn)
    };
  }

  private async cancelAcceptedStart(input: DecideHomeConsentCommand, turn: HomeTurn): Promise<HomeConsentDecisionResponse> {
    let confirmed = false;
    try {
      confirmed = (await this.runtime?.cancel(input.turnId))?.outcome === 'confirmed';
    } catch {
      confirmed = false;
    }
    const resolved = await this.conversations.updateTurnStatus({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      status: confirmed ? 'cancelled' : 'unknown'
    });
    if (!resolved) throw new HomeConversationNotFoundError();
    return {
      turn: resolved,
      disclosure: await this.requiredDisclosure(input),
      replayed: false,
      execution: { state: confirmed ? 'cancelled' : 'unknown', ...(!confirmed ? { code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' } : {}) }
    };
  }

  private async requiredDisclosure(input: DecideHomeConsentCommand): Promise<NonNullable<Awaited<ReturnType<IHomeConversationRepository['findConsentDisclosure']>>>> {
    const disclosure = await this.conversations.findConsentDisclosure(input.ownerId, input.conversationId, input.turnId, input.disclosureId);
    if (!disclosure) throw new HomeConversationNotFoundError();
    return disclosure;
  }
}

function matchesProvider(result: HomeConsentDecisionResult, provider: HomePlanningProvider): boolean {
  return result.disclosure.providerProfile === provider.profile && result.disclosure.model === provider.model;
}

function matchesInitialSnapshot(
  current: { readonly disclosure: NonNullable<Awaited<ReturnType<IHomeConversationRepository['findConsentDisclosure']>>>; readonly conversation: HomeConversation },
  context: { readonly categories: readonly string[]; readonly itemCount: number }
): boolean {
  const scopeMatches = current.disclosure.scope.kind === current.conversation.scope.kind
    && (current.disclosure.scope.kind === 'home'
      || (current.conversation.scope.kind === 'workspace'
        && current.disclosure.scope.workspaceId === current.conversation.scope.workspaceId));
  const categoriesMatch = current.disclosure.categories.length === context.categories.length
    && current.disclosure.categories.every((category, index) => category === context.categories[index]);
  return scopeMatches && categoriesMatch && current.disclosure.itemCount === context.itemCount
    && current.disclosure.byteLimit === MAX_INITIAL_PROMPT_BYTES;
}

function replayExecution(turn: HomeTurn): HomeTurnExecution {
  if (turn.status === 'running') return { state: 'running' };
  if (turn.status === 'cancelled' || turn.status === 'cancel_requested') return { state: 'cancelled' };
  if (turn.status === 'unsupported') return { state: 'unsupported', code: 'PLANNING_RUNTIME_UNAVAILABLE' };
  if (turn.status === 'unknown') return { state: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' };
  return { state: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' };
}

function executionForDelivery(outcome: 'accepted' | 'unavailable' | 'unknown', turn: HomeTurn): HomeTurnExecution {
  if (turn.status === 'cancelled' || turn.status === 'cancel_requested') return { state: 'cancelled' };
  if (outcome === 'accepted' && turn.status === 'running') return { state: 'running' };
  if (outcome === 'unavailable' && turn.status === 'unsupported') return { state: 'unsupported', code: 'PLANNING_RUNTIME_UNAVAILABLE' };
  return { state: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' };
}

function replayToolExecution(turn: HomeTurn, deliveryState: string): HomeTurnExecution {
  if (turn.status === 'running' && deliveryState === 'accepted') return { state: 'resumed' };
  if (turn.status === 'running' && ['starting', 'not_required', 'unknown'].includes(deliveryState)) {
    return { state: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' };
  }
  return replayExecution(turn);
}

function matchesPendingResult(pending: PendingHomeToolResult, disclosure: NonNullable<Awaited<ReturnType<IHomeConversationRepository['findConsentDisclosure']>>>): boolean {
  const serialized = JSON.stringify(pending.data);
  return pending.requestId === disclosure.runtimeRequestId
    && createFingerprint(serialized) === disclosure.resultFingerprint
    && Buffer.byteLength(serialized, 'utf8') <= disclosure.byteLimit
    && pending.byteLimit === disclosure.byteLimit
    && pending.itemCount === disclosure.itemCount
    && JSON.stringify(pending.categories) === JSON.stringify(disclosure.categories)
    && JSON.stringify(pending.scope) === JSON.stringify(disclosure.scope);
}

function createFingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

