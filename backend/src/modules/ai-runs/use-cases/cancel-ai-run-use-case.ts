import { AiRunCancellationReviewRequiredError, AiRunNotFoundError, AiRunStateConflictError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { AiRun } from '@/modules/ai-runs/domain/ai-run-types';
import type { IAgentRuntime } from '@/modules/ai-runs/repositories/agent-runtime';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IRunEventPublisher } from '@/modules/ai-runs/repositories/run-event-publisher';
import { validateIdempotencyKey } from '@/modules/ai-runs/domain/ai-run-validation';
import { hashText } from '@/modules/ai-runs/use-cases/manifest-builder';
import { assertActiveAiRunProject } from '@/modules/ai-runs/use-cases/assert-ai-run-project';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';

export interface CancelAiRunInput {
  readonly ownerId: string;
  readonly runId: string;
  readonly idempotencyKey: string;
}

export class CancelAiRunUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly agentRuntime: IAgentRuntime,
    private readonly events: IRunEventPublisher,
    private readonly projectRepository?: IProjectRepository
  ) {}

  public async execute(input: CancelAiRunInput): Promise<AiRun> {
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = hashText(JSON.stringify({ action: 'cancel', runId: input.runId }));
    if (this.projectRepository) {
      await assertActiveAiRunProject(this.aiRunRepository, this.projectRepository, input.ownerId, input.runId);
    }
    const result = this.aiRunRepository.requestCancellation
      ? await this.aiRunRepository.requestCancellation({ ownerId: input.ownerId, runId: input.runId, idempotencyKey, requestFingerprint })
      : await this.requestWithLegacyRepository(input, idempotencyKey, requestFingerprint);
    this.publish(result.resource);
    if (result.replayed || result.resource.status === 'cancelled') {
      return result.resource;
    }
    if (!this.agentRuntime.cancelRun) {
      await this.markReview(input.ownerId, input.runId);
      throw new AiRunCancellationReviewRequiredError();
    }
    try {
      const cancellation = await this.agentRuntime.cancelRun({ runId: input.runId });
      if (cancellation.outcome === 'unknown') {
        await this.markReview(input.ownerId, input.runId);
        throw new AiRunCancellationReviewRequiredError();
      }
      const cancelled = this.aiRunRepository.markCancelled
        ? await this.aiRunRepository.markCancelled(input.ownerId, input.runId)
        : await this.markCancelledLegacy(input.ownerId, input.runId);
      if (!cancelled) {
        throw new AiRunNotFoundError();
      }
      this.publish(cancelled);
      return cancelled;
    } catch (error: unknown) {
      if (error instanceof AiRunCancellationReviewRequiredError) {
        throw error;
      }
      await this.markReview(input.ownerId, input.runId);
      throw new AiRunCancellationReviewRequiredError();
    }
  }

  private async requestWithLegacyRepository(input: CancelAiRunInput, idempotencyKey: string, requestFingerprint: string): Promise<{ readonly resource: AiRun; readonly replayed: boolean }> {
    const current = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!current) {
      throw new AiRunNotFoundError();
    }
    if (current.cancelIdempotencyKey) {
      if (current.cancelIdempotencyKey !== idempotencyKey || current.cancelFingerprint !== requestFingerprint) {
        throw new AiRunStateConflictError();
      }
      return { resource: current, replayed: true };
    }
    if (!['ready', 'queued', 'running', 'waiting_approval'].includes(current.status)) {
      return { resource: current, replayed: true };
    }
    const immediate = current.status === 'ready' || current.status === 'queued';
    const updated: AiRun = { ...current, status: immediate ? 'cancelled' : 'cancel_requested', phase: 'terminal', cancelIdempotencyKey: idempotencyKey, cancelFingerprint: requestFingerprint, cleanup: immediate ? 'complete' : current.cleanup, safeMessage: immediate ? 'Run cancelled. No further assistant work will be applied.' : 'Stopping assistant run.', updatedAt: new Date() };
    await this.aiRunRepository.save(updated);
    return { resource: updated, replayed: false };
  }

  private async markCancelledLegacy(ownerId: string, runId: string): Promise<AiRun | null> {
    const current = await this.aiRunRepository.findByIdForOwner(ownerId, runId);
    if (!current || current.status !== 'cancel_requested') {
      return current;
    }
    const updated: AiRun = { ...current, status: 'cancelled', phase: 'terminal', cleanup: 'complete', safeMessage: 'Run cancelled. No further assistant work will be applied.', updatedAt: new Date() };
    await this.aiRunRepository.save(updated);
    return updated;
  }

  private async markReview(ownerId: string, runId: string): Promise<void> {
    const updated = this.aiRunRepository.markReviewRequired
      ? await this.aiRunRepository.markReviewRequired(ownerId, runId, 'Run status needs review. We could not confirm whether the run stopped. Refresh run status before retrying.')
      : null;
    if (updated) {
      this.publish(updated);
    }
  }

  private publish(run: AiRun): void {
    const type = run.status === 'cancel_requested' ? 'run.cancel_requested' : run.status === 'cancelled' ? 'run.cancelled' : run.status === 'review_required' ? 'run.needs_manual_review' : 'run.status_changed';
    this.events.publish({ runId: run.id, type, payload: { status: run.status, phase: run.phase, safeMessage: run.safeMessage } });
  }
}
