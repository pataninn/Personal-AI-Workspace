import { AiRunStateConflictError } from '@/modules/ai-runs/domain/ai-run-errors';
import { ASSISTANT_OUTPUT_LIMIT_MESSAGE, MAX_ASSISTANT_DELTA_BYTES, MAX_ASSISTANT_OUTPUT_BYTES, assistantTextExceedsLimit, sanitizeAssistantText, truncateAssistantDelta } from '@/modules/ai-runs/domain/assistant-output';
import type { AiRun } from '@/modules/ai-runs/domain/ai-run-types';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IAgentRuntime, RuntimeInferenceEvent } from '@/modules/ai-runs/repositories/agent-runtime';
import type { IRunEventPublisher } from '@/modules/ai-runs/repositories/run-event-publisher';
import type { IConversationRepository } from '@/modules/conversations/repositories/conversation-repository';
import { validateIdempotencyKey } from '@/modules/ai-runs/domain/ai-run-validation';
import { hashText } from '@/modules/ai-runs/use-cases/manifest-builder';
import { assertActiveAiRunProject } from '@/modules/ai-runs/use-cases/assert-ai-run-project';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { RuntimeChangeProposal } from '@/modules/ai-runs/domain/change-types';

export interface RuntimeCommandProposalPort {
  execute(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly command: unknown;
    readonly args: unknown;
    readonly cwd?: unknown;
    readonly summary?: unknown;
    readonly idempotencyKey: string;
  }): Promise<{ readonly resource: { readonly id: string; readonly status: string; readonly safeMessage: string }; readonly replayed: boolean }>;
}

export interface RuntimeChangeSetProposalPort {
  execute(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly changes: readonly RuntimeChangeProposal[];
    readonly fakeRuntime: boolean;
  }): Promise<unknown>;
}

export interface StartAiRunInput {
  readonly ownerId: string;
  readonly runId: string;
  readonly idempotencyKey: string;
}

export class StartAiRunUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly conversationRepository: IConversationRepository,
    private readonly agentRuntime: IAgentRuntime,
    private readonly events: IRunEventPublisher,
    private readonly commandProposals?: RuntimeCommandProposalPort,
    private readonly projectRepository?: IProjectRepository,
    private readonly changeSetProposals?: RuntimeChangeSetProposalPort
  ) {}

  public async execute(input: StartAiRunInput): Promise<{ readonly resource: AiRun; readonly replayed: boolean }> {
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = hashText(JSON.stringify({ action: 'start', runId: input.runId }));
    if (this.projectRepository) {
      await assertActiveAiRunProject(this.aiRunRepository, this.projectRepository, input.ownerId, input.runId);
    }
    const result = this.aiRunRepository.beginStart
      ? await this.aiRunRepository.beginStart({ ownerId: input.ownerId, runId: input.runId, idempotencyKey, requestFingerprint })
      : await this.beginWithLegacyRepository(input, idempotencyKey, requestFingerprint);
    if (!result.replayed) {
      await this.publishStatus(result.resource, 'run.status_changed');
      void this.runSafely(result.resource);
    }
    return result;
  }

  private async beginWithLegacyRepository(input: StartAiRunInput, idempotencyKey: string, requestFingerprint: string): Promise<{ readonly resource: AiRun; readonly replayed: boolean }> {
    const current = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!current) {
      throw new AiRunStateConflictError();
    }
    if (current.startIdempotencyKey) {
      if (current.startIdempotencyKey !== idempotencyKey || current.startFingerprint !== requestFingerprint) {
        throw new AiRunStateConflictError();
      }
      return { resource: current, replayed: true };
    }
    if (current.status !== 'ready') {
      throw new AiRunStateConflictError();
    }
    const updated: AiRun = { ...current, status: 'queued', phase: 'inference', startIdempotencyKey: idempotencyKey, startFingerprint: requestFingerprint, safeMessage: 'Starting assistant run.', updatedAt: new Date() };
    await this.aiRunRepository.save(updated);
    return { resource: updated, replayed: false };
  }

  private async runSafely(run: AiRun): Promise<void> {
    try {
      await this.run(run);
    } catch {
      await this.markReview(run.id, run.ownerId, 'The assistant run stopped before its outcome could be confirmed. Refresh run status before retrying.');
    }
  }

  private async run(run: AiRun): Promise<void> {
    const running = this.aiRunRepository.markRunning
      ? await this.aiRunRepository.markRunning(run.ownerId, run.id)
      : await this.markRunningLegacy(run);
    if (!running || isStopState(running.status)) {
      return;
    }
    if (!await this.publishStatus(running, 'run.started')) {
      return;
    }
    if (!this.agentRuntime.startRun) {
      await this.finish(running, 'failed', 'The assistant could not start this run. The configured runtime is unavailable.');
      return;
    }
    let assistantText = '';
    let terminal: RuntimeInferenceEvent | undefined;
    try {
      for await (const event of this.agentRuntime.startRun({ runId: running.id, request: running.request, manifest: running.manifest, ...(running.runtimeReference ? { stagedReference: running.runtimeReference } : {}) })) {
        const current = await this.aiRunRepository.findByIdForOwner(running.ownerId, running.id);
        if (!current || isStopState(current.status)) {
          if (current?.status === 'cancel_requested') {
            await this.finishCancellation(current);
          }
          return;
        }
        const result = await this.projectEvent(current, event, assistantText);
        assistantText = result.assistantText;
        if (result.suppressed) {
          return;
        }
        if (result.outputLimitExceeded) {
          await this.finish(current, 'review_required', ASSISTANT_OUTPUT_LIMIT_MESSAGE, assistantText);
          return;
        }
        if (result.terminal) {
          terminal = event;
          break;
        }
      }
      if (!terminal) {
        await this.markReview(run.id, run.ownerId, 'The assistant stream ended before a terminal result was confirmed. Refresh run status before retrying.');
        return;
      }
      await this.finishFromEvent(run.ownerId, run.id, terminal, assistantText);
    } catch {
      await this.finish(run, 'review_required', 'The assistant run stopped, but the app could not confirm its final outcome. Refresh run status before retrying.');
    } finally {
      await this.destroySafely(run);
    }
  }

  private async projectEvent(run: AiRun, event: RuntimeInferenceEvent, assistantText: string): Promise<{ readonly assistantText: string; readonly terminal: boolean; readonly outputLimitExceeded?: boolean; readonly suppressed?: boolean }> {
    if (!await this.isRunProjectable(run.ownerId, run.id)) {
      return { assistantText, terminal: false, suppressed: true };
    }
    if (event.type === 'started') {
      if (!await this.publishProjected(run.ownerId, run.id, 'run.started', { status: 'running' })) {
        return { assistantText, terminal: false, suppressed: true };
      }
      return { assistantText, terminal: false };
    }
    if (event.type === 'assistant.delta') {
      if (Buffer.byteLength(event.text, 'utf8') > MAX_ASSISTANT_DELTA_BYTES || assistantTextExceedsLimit(`${assistantText}${event.text}`)) {
        return { assistantText: sanitizeAssistantText(`${assistantText}${event.text}`), terminal: false, outputLimitExceeded: true };
      }
      const delta = truncateAssistantDelta(event.text);
      const next = sanitizeAssistantText(`${assistantText}${delta}`);
      if (delta && next.length > assistantText.length) {
        if (!await this.publishProjected(run.ownerId, run.id, 'assistant.delta', { text: next.slice(assistantText.length), messageId: `run:${run.id}` })) {
          return { assistantText, terminal: false, suppressed: true };
        }
      }
      return { assistantText: next, terminal: false };
    }
    if (event.type === 'assistant.message.completed') {
      if (assistantTextExceedsLimit(event.text)) {
        return { assistantText: sanitizeAssistantText(event.text), terminal: false, outputLimitExceeded: true };
      }
      const text = sanitizeAssistantText(event.text);
      if (!await this.publishProjected(run.ownerId, run.id, 'assistant.message.completed', { contentLength: Buffer.byteLength(text, 'utf8'), empty: text.length === 0 })) {
        return { assistantText, terminal: false, suppressed: true };
      }
      return { assistantText: text, terminal: false };
    }
    if (event.type === 'changes.proposed') {
      if (!this.changeSetProposals) {
        return { assistantText, terminal: false };
      }
      await this.changeSetProposals.execute({ ownerId: run.ownerId, runId: run.id, changes: event.changes, fakeRuntime: run.runtimeKind === 'fake' });
      return { assistantText, terminal: false };
    }
    if (event.type === 'tool.proposed') {
      const projected = await this.projectCommand(run, event);
      return projected ? { assistantText, terminal: false } : { assistantText, terminal: false, suppressed: true };
    }
    if (event.type === 'approval.required') {
      if (this.aiRunRepository.markWaitingApproval) {
        const waiting = await this.aiRunRepository.markWaitingApproval(run.ownerId, run.id, 'The assistant is waiting for a sandbox command decision.');
        if (!waiting || isStopState(waiting.status) || !await this.publishStatus(waiting, 'run.status_changed')) {
          return { assistantText, terminal: false, suppressed: true };
        }
      }
      if (!await this.publishProjected(run.ownerId, run.id, 'approval.required', { commandId: event.commandId })) {
        return { assistantText, terminal: false, suppressed: true };
      }
      return { assistantText, terminal: false };
    }
    if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.failed') {
      if (event.type === 'tool.started' && this.aiRunRepository.markRunning) {
        const resumed = await this.aiRunRepository.markRunning(run.ownerId, run.id);
        if (resumed) {
          if (isStopState(resumed.status) || !await this.publishStatus(resumed, 'run.status_changed')) {
            return { assistantText, terminal: false, suppressed: true };
          }
        }
      }
      if (!await this.publishProjected(run.ownerId, run.id, event.type, { commandId: event.commandId, status: event.type === 'tool.started' ? 'running' : event.status })) {
        return { assistantText, terminal: false, suppressed: true };
      }
      return { assistantText, terminal: false };
    }
    if (event.type === 'completed') {
      if (event.text && assistantTextExceedsLimit(event.text)) {
        return { assistantText: sanitizeAssistantText(event.text), terminal: false, outputLimitExceeded: true };
      }
      return { assistantText: sanitizeAssistantText(event.text || assistantText), terminal: true };
    }
    if (event.type === 'failed' || event.type === 'blocked' || event.type === 'needs_manual_review' || event.type === 'cancelled') {
      return { assistantText, terminal: true };
    }
    return { assistantText, terminal: false };
  }

  private async projectCommand(run: AiRun, event: Extract<RuntimeInferenceEvent, { readonly type: 'tool.proposed' }>): Promise<boolean> {
    if (!this.commandProposals) {
      return this.publishProjected(run.ownerId, run.id, 'tool.proposed', { status: 'review_required', safeMessage: 'The command proposal could not be registered.' });
    }
    if (!await this.isRunProjectable(run.ownerId, run.id)) {
      return false;
    }
    try {
      const proposal = await this.commandProposals.execute({ ownerId: run.ownerId, runId: run.id, command: event.proposal.command, args: event.proposal.args, cwd: event.proposal.cwd, idempotencyKey: `run-command-${hashText(JSON.stringify(event.proposal)).slice(0, 32)}` });
      return this.publishProjected(run.ownerId, run.id, 'tool.proposed', { commandId: proposal.resource.id, status: proposal.resource.status, safeMessage: proposal.resource.safeMessage });
    } catch {
      await this.markReview(run.id, run.ownerId, 'The command proposal could not be confirmed. Refresh command and run status before retrying.');
      return false;
    }
  }

  private async finishFromEvent(ownerId: string, runId: string, event: RuntimeInferenceEvent, assistantText: string): Promise<void> {
    if (event.type === 'cancelled') {
      const current = await this.aiRunRepository.findByIdForOwner(ownerId, runId);
      if (current?.status === 'cancel_requested') {
        await this.finishCancellation(current);
      }
      return;
    }
    const status = event.type === 'completed' ? 'succeeded' : event.type === 'blocked' ? 'blocked' : event.type === 'needs_manual_review' ? 'review_required' : 'failed';
    const safeMessage = event.type === 'completed'
      ? assistantText.length > 0 ? 'Assistant response complete.' : 'The assistant completed without a message.'
      : event.type === 'blocked' ? 'Run blocked by policy. This run was not completed.'
        : event.type === 'needs_manual_review' ? 'Run needs review. Refresh run status before retrying.'
          : 'The assistant could not complete this run.';
    const current = await this.aiRunRepository.findByIdForOwner(ownerId, runId);
    if (current) {
      await this.finish(current, status, safeMessage, assistantText);
    }
  }

  private async finish(run: AiRun, status: 'succeeded' | 'failed' | 'blocked' | 'review_required', safeMessage: string, assistantText = ''): Promise<void> {
    const bounded = sanitizeAssistantText(assistantText, MAX_ASSISTANT_OUTPUT_BYTES);
    let updated = this.aiRunRepository.completeRun
      ? await this.aiRunRepository.completeRun({ ownerId: run.ownerId, runId: run.id, status, safeMessage, assistantText: bounded, assistantComplete: status === 'succeeded', cleanup: status === 'review_required' ? 'unknown' : 'complete', providerTransmission: status === 'review_required' ? 'unknown' : run.providerTransmission })
      : await this.completeLegacy(run, status, safeMessage, bounded);
    if (updated?.status === status && bounded && !updated.assistantMessageId && this.conversationRepository.addAssistantMessage) {
      const message = await this.conversationRepository.addAssistantMessage({ ownerId: run.ownerId, projectId: run.projectId, conversationId: run.conversationId, content: bounded, idempotencyKey: `run-assistant-${run.id}`, requestFingerprint: hashText(JSON.stringify({ runId: run.id, content: bounded })) });
      updated = { ...updated, assistantMessageId: message.resource.id };
      await this.aiRunRepository.save(updated);
    }
    if (updated?.status === status) {
      this.publishTerminal(updated);
    } else if (updated?.status === 'cancel_requested') {
      await this.finishCancellation(updated);
    }
  }

  private async completeLegacy(run: AiRun, status: 'succeeded' | 'failed' | 'blocked' | 'review_required', safeMessage: string, assistantText: string): Promise<AiRun> {
    const updated: AiRun = { ...run, status, phase: status === 'review_required' ? 'review' : 'terminal', assistantComplete: status === 'succeeded', assistantContentLength: assistantText.length, safeMessage, updatedAt: new Date() };
    await this.aiRunRepository.save(updated);
    if (assistantText && this.conversationRepository.addAssistantMessage) {
      const message = await this.conversationRepository.addAssistantMessage({ ownerId: run.ownerId, projectId: run.projectId, conversationId: run.conversationId, content: assistantText, idempotencyKey: `run-assistant-${run.id}`, requestFingerprint: hashText(JSON.stringify({ runId: run.id, content: assistantText })) });
      const withMessage = { ...updated, assistantMessageId: message.resource.id };
      await this.aiRunRepository.save(withMessage);
      return withMessage;
    }
    return updated;
  }

  private async markRunningLegacy(run: AiRun): Promise<AiRun | null> {
    const current = await this.aiRunRepository.findByIdForOwner(run.ownerId, run.id);
    if (!current || current.status !== 'queued') {
      return current;
    }
    const updated = { ...current, status: 'running' as const, phase: 'inference' as const, safeMessage: 'Assistant is working.', updatedAt: new Date() };
    await this.aiRunRepository.save(updated);
    return updated;
  }

  private async finishCancellation(run: AiRun): Promise<void> {
    const updated = this.aiRunRepository.markCancelled ? await this.aiRunRepository.markCancelled(run.ownerId, run.id) : run;
    if (updated?.status === 'cancelled') {
      this.publishTerminal(updated);
    }
  }

  private async markReview(runId: string, ownerId: string, message: string): Promise<void> {
    const updated = this.aiRunRepository.markReviewRequired ? await this.aiRunRepository.markReviewRequired(ownerId, runId, message) : null;
    if (updated) {
      this.publishTerminal(updated);
    }
  }

  private async destroySafely(run: AiRun): Promise<void> {
    try {
      await this.agentRuntime.destroy(run.id);
    } catch {
      const current = await this.aiRunRepository.findByIdForOwner(run.ownerId, run.id);
      if (current && current.status !== 'rejected' && current.status !== 'review_required') {
        await this.markReview(run.id, run.ownerId, 'Run cleanup could not be confirmed. Refresh run status before retrying.');
      }
    }
  }

  private async publishStatus(run: AiRun, type: 'run.started' | 'run.status_changed'): Promise<boolean> {
    return this.publishProjected(run.ownerId, run.id, type, { status: run.status, phase: run.phase, safeMessage: run.safeMessage });
  }

  private async isRunProjectable(ownerId: string, runId: string): Promise<boolean> {
    const current = await this.aiRunRepository.findByIdForOwner(ownerId, runId);
    return Boolean(current && !isStopState(current.status));
  }

  private async publishProjected(ownerId: string, runId: string, type: Parameters<IRunEventPublisher['publish']>[0]['type'], payload: Readonly<Record<string, unknown>>): Promise<boolean> {
    if (this.aiRunRepository.withRunProjection) {
      return this.aiRunRepository.withRunProjection(ownerId, runId, () => {
        this.publish(runId, type, payload);
      });
    }
    if (!await this.isRunProjectable(ownerId, runId)) {
      return false;
    }
    this.publish(runId, type, payload);
    return true;
  }

  private publishTerminal(run: AiRun): void {
    const type = run.status === 'succeeded' ? 'run.completed' : run.status === 'cancelled' ? 'run.cancelled' : run.status === 'blocked' ? 'run.blocked' : run.status === 'review_required' ? 'run.needs_manual_review' : 'run.failed';
    this.publish(run.id, type, { status: run.status, phase: run.phase, safeMessage: run.safeMessage, ...(run.assistantMessageId ? { messageId: run.assistantMessageId } : {}), contentLength: run.assistantContentLength ?? 0 });
  }

  private publish(runId: string, type: Parameters<IRunEventPublisher['publish']>[0]['type'], payload: Readonly<Record<string, unknown>>): void {
    this.events.publish({ runId, type, payload });
  }
}

function isStopState(status: AiRun['status']): boolean {
  return status === 'cancel_requested' || status === 'cancelled' || status === 'succeeded' || status === 'failed' || status === 'blocked' || status === 'review_required' || status === 'rejected';
}
