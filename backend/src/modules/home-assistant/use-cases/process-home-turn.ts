import { DEFAULT_CONVERSATION_TITLE, GeneratedConversationTitle } from '@/modules/conversations/domain/generated-conversation-title';
import type { AssertAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import type { HomeConversationScope, HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import { HomeConversationNotFoundError, HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { CancelHomeTurnInput, IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomePlanningProvider, HomePlanningRuntimeEvent, IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import type { IHomePlanningToolRequestHandler } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';
import type { HomeAutomationFence } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { IHomeAutomationSourceRecorder } from '@/modules/home-assistant/repositories/home-automation-source-recorder';
import type { IHomeProviderCreditReceiptHandler } from '@/modules/home-assistant/repositories/home-provider-credit-receipt-handler';
import { HOME_NEBIUS_NEMOTRON_BOUND } from '@/modules/credits/domain/home-provider-credit-bound';
import { redactEgressText } from '@/shared/egress/redaction';

const MAX_RUNTIME_EVENTS = 2000;
const MAX_RUNTIME_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_ASSISTANT_BYTES = 256 * 1024;
const MAX_POLL_PAGES_PER_READ = 8;

interface RuntimePollState {
  readonly titleStream?: GeneratedConversationTitle;
  cursor: number;
  lastEventSequence: number;
  events: number;
  historyBytes: number;
  outputBytes: number;
  output: string;
  truncated: boolean;
  cleanupPending: boolean;
  cancelBeforeCleanup: boolean;
  runtimeDisposed: boolean;
  cancellationConfirmed: boolean;
  cleanupIdentity?: CancelHomeTurnInput;
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

/** Advances an owned Home turn while its persisted policy binding remains current. */
export class ProcessHomeTurnUseCase {
  private readonly pollStates = new Map<string, RuntimePollState>();
  private readonly cleanups = new Map<string, Promise<void>>();
  private readonly activePolls = new Map<string, Promise<void>>();

  public constructor(
    private readonly conversations: IHomeConversationRepository,
    private readonly runtime?: IHomePlanningRuntime,
    private readonly toolRequestHandler?: IHomePlanningToolRequestHandler,
    private readonly policyConfiguration?: HomeTurnPolicyConfiguration,
    private readonly automationSources?: IHomeAutomationSourceRecorder,
    private readonly providerCreditReceipts?: IHomeProviderCreditReceiptHandler
  ) {}

  public async execute(input: { readonly ownerId: string; readonly conversationId: string; readonly turnId: string; readonly automationGuard?: TrustedScheduledTurnGuard }): Promise<HomeTurn> {
    const conversation = await this.conversations.findForOwner(input.ownerId, input.conversationId);
    if (!conversation) throw new HomeConversationNotFoundError();
    const turn = await this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId);
    if (!turn) throw new HomeTurnNotFoundError();
    if (turn.automationOccurrenceId && input.automationGuard?.fence.occurrenceId !== turn.automationOccurrenceId) return turn;
    if (input.automationGuard && turn.automationOccurrenceId !== input.automationGuard.fence.occurrenceId) return turn;
    if (this.pollStates.get(turn.id)?.cleanupPending) await this.retryCleanup(turn.id);
    if (turn.status === 'unknown') {
      await this.providerCreditReceipts?.markInterrupted(input.ownerId, turn.id);
      this.providerCreditReceipts?.clearTurn(turn.id);
      // Settled receipts do not authorize resuming an abandoned or uncertain native runtime.
      return turn;
    }

    if (!hasPolicyBinding(turn, conversation.scope)) {
      return this.blockLegacyTurn(turn, input.ownerId, input.conversationId, input.automationGuard);
    }
    if (turn.status === 'running') {
      if (this.runtime) await this.pollRuntime(turn, input.ownerId, input.conversationId, conversation.scope, input.automationGuard);
      else if (turn.status === 'running') return await this.blockActiveTurn(turn, input.ownerId, input.conversationId, input.automationGuard);
    }
    const latest = await this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId) ?? turn;
    if (latest.status === 'cancelled') await this.deleteTerminalRuntime(input.ownerId, turn.id);
    return latest;
  }

  public async drainCleanup(): Promise<void> {
    await Promise.all(this.cleanups.values());
    await Promise.all([...this.pollStates].filter(([, state]) => state.cleanupPending)
      .map(([turnId]) => this.retryCleanup(turnId)));
  }

  /** Registers trusted startup compensation with the same retry queue used by periodic maintenance. */
  public async queueAbandonedRuntime(input: CancelHomeTurnInput): Promise<boolean> {
    try { await this.clearRuntime(input); }
    catch {
      // Receipt persistence can fail independently; in-flight/unknown ledger rows remain fail-closed.
      // The return value proves only runtime disposal, never provider settlement.
    }
    return this.runtime !== undefined && !this.pollStates.has(input.turnId);
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
    const namingConversation = !this.pollStates.has(turn.id) && this.conversations.setGeneratedTitle
      ? await this.conversations.findForOwner(ownerId, conversationId) : null;
    const state = this.pollStates.get(turn.id) ?? { ...newPollState(), cleanupIdentity: { ownerId, conversationId, turnId: turn.id },
      titleStream: new GeneratedConversationTitle(namingConversation?.title === DEFAULT_CONVERSATION_TITLE) };
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
        await this.abandonRuntime(ownerId, conversationId, turn.id);
        return;
      }
      if (page.status === 'unknown') {
        await this.abandonRuntime(ownerId, conversationId, turn.id);
        return;
      }
      if (page.status === 'failed' && page.code === 'PLANNING_RUNTIME_BUDGET_EXHAUSTED' && turn.automationOccurrenceId) {
        if (!guard || guard.fence.occurrenceId !== turn.automationOccurrenceId || !this.automationSources
          || !await guard.isCurrent()) {
          await this.abandonRuntime(ownerId, conversationId, turn.id);
          return;
        }
        let skipped = false;
        try { skipped = await this.automationSources.markBudgetSkipped({ ownerId, fence: guard.fence }); }
        catch { /* An uncertain source write must abandon this runtime, never retry provider work. */ }
        if (!skipped) {
          await this.abandonRuntime(ownerId, conversationId, turn.id);
          return;
        }
      }
      const recorded = await this.recordRuntimeEvents(turn, ownerId, conversationId, scope, state, page.events, guard);
      if (recorded === 'abandoned') return;
      if (recorded === 'invalid') {
        await this.abandonRuntime(ownerId, conversationId, turn.id);
        return;
      }
      if (recorded === 'blocked') {
        await this.stopRuntimeAndMark(turn, ownerId, conversationId, guard);
        return;
      }
      if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < state.cursor || page.nextCursor < state.lastEventSequence
        || (page.hasMore && page.nextCursor === state.cursor)) {
        await this.abandonRuntime(ownerId, conversationId, turn.id);
        return;
      }
      state.cursor = page.nextCursor;
      if (page.status === 'completed') {
        if (page.hasMore) continue;
        if (!await this.isAuthorized(turn, ownerId, conversationId, scope, undefined, guard)) {
          await this.stopRuntimeAndMark(turn, ownerId, conversationId, guard);
          return;
        }
        if (requiresHomeProviderAdmission(this.policyConfiguration)
          && !this.providerCreditReceipts?.hasAdmittedCall(turn.id)) {
          state.output = '';
          state.outputBytes = 0;
          const failed = await this.updateStatus(ownerId, conversationId, turn.id, 'failed');
          if (failed?.status === 'failed') await this.deleteTerminalRuntime(ownerId, turn.id);
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
        if (completed && ['completed', 'partial'].includes(completed.status)) await this.deleteTerminalRuntime(ownerId, turn.id, false);
        return;
      }
      if (page.status === 'failed' || page.status === 'cancelled') {
        const updated = await this.updateStatus(ownerId, conversationId, turn.id, page.status);
        if (updated && ['failed', 'cancelled'].includes(updated.status)) await this.deleteTerminalRuntime(ownerId, turn.id);
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
  ): Promise<'ok' | 'blocked' | 'invalid' | 'abandoned'> {
    let lastSequence = state.lastEventSequence;
    for (const [index, event] of events.entries()) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence) return 'invalid';
      lastSequence = event.sequence;
      state.events += 1;
      state.historyBytes += encodedBytes(event);
      if (state.events > MAX_RUNTIME_EVENTS || state.historyBytes > MAX_RUNTIME_HISTORY_BYTES) return 'invalid';
      if (event.type === 'assistant.delta') {
        const parsed = state.titleStream?.push(event.text) ?? { text: event.text };
        if (parsed.title) {
          // Naming is optional: a storage limit must not discard a useful reply.
          await this.conversations.setGeneratedTitle?.({ ownerId, conversationId, title: parsed.title }).catch(() => false);
        }
        const text = redactEgressText(parsed.text);
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
        const targetProjectIds = candidate.authorizationProjectIds ?? [];
        if (scope.kind === 'workspace' && targetProjectIds.some((id) => id !== scope.workspaceId)) return 'blocked';
        if (!await this.isAuthorized(turn, ownerId, conversationId, scope, undefined, guard)) return 'blocked';
        for (const projectId of targetProjectIds) {
          if (!await this.isAuthorized(turn, ownerId, conversationId, scope, projectId, guard)) return 'blocked';
        }
        if (turn.automationOccurrenceId && candidate.taskSources?.length) {
          if (!guard || guard.fence.occurrenceId !== turn.automationOccurrenceId || !this.automationSources
            || !await guard.isCurrent()) return 'blocked';
          let recorded: Awaited<ReturnType<IHomeAutomationSourceRecorder['recordTaskSources']>>;
          try {
            recorded = await this.automationSources.recordTaskSources({ ownerId, fence: guard.fence, sources: candidate.taskSources });
          } catch {
            return 'blocked';
          }
          if (recorded !== 'recorded') return 'blocked';
        }
        try {
          const sent = await this.runtime?.sendToolResult({ turnId: turn.id, requestId: event.requestId, result: candidate.result });
          if (!sent?.accepted) return 'blocked';
        } catch {
          return 'blocked';
        }
      } else if (event.type === 'home.provider.credit.requested') {
        if (turn.status === 'unknown' && guard) return 'blocked';
        if (index !== events.length - 1 || !this.providerCreditReceipts || !this.runtime?.sendProviderCreditResult
          || !await this.isAuthorized(turn, ownerId, conversationId, scope, undefined, guard)) return 'blocked';
        if (turn.automationOccurrenceId && (!guard || turn.automationOccurrenceId !== guard.fence.occurrenceId || !await guard.isCurrent())) return 'blocked';
        let result;
        try {
          result = await this.providerCreditReceipts.handle({
            ownerId,
            turnId: turn.id,
            providerProfile: this.policyConfiguration?.providerProfile ?? '',
            model: this.policyConfiguration?.model ?? '',
            request: event.request
          });
        } catch {
          return 'blocked';
        }
        if (result.outcome === 'denied' && result.code === 'BUDGET_EXHAUSTED' && turn.automationOccurrenceId
          && !this.providerCreditReceipts.hasAdmittedCall(turn.id)) {
          if (!guard || !this.automationSources || !await guard.isCurrent()
            || !await this.automationSources.markBudgetSkipped({ ownerId, fence: guard.fence })) return 'blocked';
        }
        try {
          const sent = await this.runtime.sendProviderCreditResult({ turnId: turn.id, requestId: event.requestId, result });
          if (!sent.accepted) return 'blocked';
        } catch {
          return 'blocked';
        }
        if (result.outcome === 'unknown' || event.request.operation === 'unknown') {
          await this.abandonRuntime(ownerId, conversationId, turn.id);
          return 'abandoned';
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
    try {
      const current = await this.conversations.findTurnForOwner(ownerId, conversationId, turn.id);
      if (!current) throw new HomeTurnNotFoundError();
      if (current.status !== 'running' && current.status !== 'cancel_requested') return current;
      return await this.updateStatus(ownerId, conversationId, turn.id, cancelled ? 'cancelled' : 'unknown') ?? current;
    } finally {
      if (cancelled) {
        const state = this.pollStates.get(turn.id) ?? newPollState();
        state.cancellationConfirmed = true;
        state.cleanupIdentity = { ownerId, conversationId, turnId: turn.id };
        this.pollStates.set(turn.id, state);
        await this.deleteTerminalRuntime(ownerId, turn.id);
      }
      else await this.clearRuntime({ ownerId, conversationId, turnId: turn.id });
    }
  }

  private async updateStatus(ownerId: string, conversationId: string, turnId: string, status: 'failed' | 'cancelled' | 'unknown' | 'unsupported'): Promise<HomeTurn | null> {
    return this.conversations.updateTurnStatus({ ownerId, conversationId, turnId, status });
  }

  private async deleteTerminalRuntime(ownerId: string, turnId: string, waitForDeletion = true): Promise<void> {
    try { await this.providerCreditReceipts?.markInterrupted(ownerId, turnId); }
    finally {
      this.providerCreditReceipts?.clearTurn(turnId);
      const deletion = this.cleanupRuntime(turnId);
      if (waitForDeletion) await deletion;
    }
  }

  private cleanupRuntime(turnId: string): Promise<void> {
    const pending = this.cleanups.get(turnId);
    if (pending) return pending;
    if (!this.runtime) return Promise.resolve();
    const runtime = this.runtime;
    const deletion = (async () => {
      const state = this.pollStates.get(turnId);
      if (state?.cleanupIdentity && !state.runtimeDisposed) {
        try { state.runtimeDisposed = await this.conversations.hasRuntimeDisposal?.(state.cleanupIdentity) ?? false; }
        catch { /* A database outage must not prevent disposal with the still-known runtime capability. */ }
      }
      if (!state?.runtimeDisposed) {
        if (state?.cancelBeforeCleanup) {
          if ((await runtime.cancel(turnId)).outcome !== 'confirmed') return;
          state.cancelBeforeCleanup = false;
          state.cancellationConfirmed = true;
        }
        await runtime.delete(turnId);
        if (state) state.runtimeDisposed = true;
      }
      if (state?.cleanupIdentity && state.cancellationConfirmed) await this.conversations.recordRuntimeDisposal?.(state.cleanupIdentity);
      this.pollStates.delete(turnId);
    })().catch(() => {
      const state = this.pollStates.get(turnId) ?? newPollState();
      state.cleanupPending = true;
      this.pollStates.set(turnId, state);
    }).finally(() => { this.cleanups.delete(turnId); });
    this.cleanups.set(turnId, deletion);
    return deletion;
  }

  private async retryCleanup(turnId: string): Promise<void> {
    await this.cleanupRuntime(turnId);
  }

  private async abandonRuntime(ownerId: string, conversationId: string, turnId: string): Promise<void> {
    try { await this.updateStatus(ownerId, conversationId, turnId, 'unknown'); }
    finally { await this.clearRuntime({ ownerId, conversationId, turnId }); }
  }

  private async clearRuntime(input: CancelHomeTurnInput): Promise<void> {
    const { ownerId, turnId } = input;
    // Disposal and provider uncertainty are independent: never leave known native capacity abandoned.
    const state = this.pollStates.get(turnId) ?? newPollState();
    state.cleanupPending = true;
    state.cancelBeforeCleanup = !state.runtimeDisposed;
    state.cleanupIdentity = input;
    this.pollStates.set(turnId, state);
    try { await this.providerCreditReceipts?.markInterrupted(ownerId, turnId); }
    finally {
      this.providerCreditReceipts?.clearTurn(turnId);
      await this.cleanupRuntime(turnId);
    }
  }
}

function hasPolicyBinding(turn: HomeTurn, scope: HomeConversationScope): boolean {
  return isRevision(turn.homePolicyRevision)
    && (scope.kind === 'home'
      ? turn.workspacePolicyRevision === null
      : isRevision(turn.workspacePolicyRevision));
}

function requiresHomeProviderAdmission(configuration?: HomeTurnPolicyConfiguration): boolean {
  return configuration?.providerProfile === HOME_NEBIUS_NEMOTRON_BOUND.providerProfile
    && configuration.model === HOME_NEBIUS_NEMOTRON_BOUND.model;
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
  return { cursor: 0, lastEventSequence: 0, events: 0, historyBytes: 0, outputBytes: 0, output: '', truncated: false, cleanupPending: false, cancelBeforeCleanup: false, runtimeDisposed: false, cancellationConfirmed: false };
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
