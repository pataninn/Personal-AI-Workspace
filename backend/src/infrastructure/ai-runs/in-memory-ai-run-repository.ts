import { randomUUID } from 'node:crypto';

import {
  AiRunAlreadyDecidedError,
  AiRunIdempotencyReusedError,
  AiRunManifestConflictError,
  AiRunNotFoundError,
  AiRunStateConflictError
} from '@/modules/ai-runs/domain/ai-run-errors';
import type {
  AiRun,
  CreateAiRunRecord,
  DecisionResult,
  DecisionUpdate
} from '@/modules/ai-runs/domain/ai-run-types';
import type { AiRunActivityRecordPage, ListAiRunActivityInput } from '@/modules/ai-runs/domain/activity-types';
import type { CancelRunUpdate, CompleteRunUpdate, RunMutationResult, StartRunUpdate } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { ProjectTaskSuggestion } from '@/modules/tasks/domain/project-task';
import { normalizeTaskSuggestionDrafts } from '@/modules/tasks/domain/project-task-validation';
import type { IProjectTaskSuggestionQuery } from '@/modules/tasks/repositories/task-suggestion-query';

interface IdempotentRunRecord {
  readonly fingerprint: string;
  readonly resourceId: string;
}

export class InMemoryAiRunRepository implements IAiRunRepository, IProjectTaskSuggestionQuery {
  private readonly runs = new Map<string, AiRun>();
  private readonly taskSuggestions = new Map<string, readonly ProjectTaskSuggestion[]>();
  private readonly idempotency = new Map<string, IdempotentRunRecord>();
  private readonly locks = new Map<string, Promise<void>>();

  public async recoverInterruptedRunsForReview(): Promise<number> {
    let recovered = 0;
    for (const run of [...this.runs.values()]) {
      await this.withLock(`start:${run.id}`, async () => {
        const current = this.runs.get(run.id);
        if (!current || !['staging', 'ready', 'queued', 'running', 'waiting_approval', 'cancel_requested'].includes(current.status)) return;
        const updated: AiRun = {
          ...current,
          status: 'review_required',
          phase: 'review',
          cleanup: 'unknown',
          providerTransmission: current.providerTransmission === 'transmitted_confirmed' || current.providerTransmission === 'not_started_confirmed'
            ? current.providerTransmission
            : 'unknown',
          safeMessage: 'The app restarted while this run was active. Review its saved status; no work was resumed automatically.',
          updatedAt: new Date()
        };
        this.runs.set(updated.id, updated);
        recovered += 1;
      });
    }
    return recovered;
  }

  public async create(input: CreateAiRunRecord): Promise<{ readonly resource: AiRun; readonly replayed: boolean }> {
    return this.withLock(this.createLockKey(input.ownerId, input.projectId, input.idempotencyKey), async () => {
      const key = this.idempotencyKey(input.ownerId, input.projectId, input.idempotencyKey);
      const previous = this.idempotency.get(key);
      if (previous) {
        if (previous.fingerprint !== input.requestFingerprint) {
          throw new AiRunIdempotencyReusedError();
        }
        const replay = this.runs.get(previous.resourceId);
        if (!replay) {
          throw new AiRunNotFoundError();
        }
        return { resource: replay, replayed: true };
      }
      const now = new Date();
      const policyAuthorized = input.policyRevision !== undefined;
      const run: AiRun = {
        id: randomUUID(),
        ownerId: input.ownerId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        request: input.request,
        relativeRoot: input.relativeRoot,
        storageKind: input.storageKind,
        requestedPaths: [...input.requestedPaths],
        manifest: input.manifest,
        manifestInvalidated: false,
        status: policyAuthorized ? 'staging' : 'pending_approval',
        phase: policyAuthorized ? 'staging' : 'decision',
        decision: policyAuthorized ? 'policy_authorized' : 'pending',
        ...(input.policyRevision ? { policyRevision: input.policyRevision } : {}),
        cleanup: 'not_started',
        providerTransmission: 'not_started_confirmed',
        stagingItemCount: 0,
        sandboxReady: false,
        safeMessage: policyAuthorized ? 'Preparing the assistant run under the saved workspace policy.' : 'Review the provider disclosure before continuing.',
        createdAt: now,
        updatedAt: now
      };
      this.runs.set(run.id, run);
      this.idempotency.set(key, { fingerprint: input.requestFingerprint, resourceId: run.id });
      return { resource: run, replayed: false };
    });
  }

  public async findByIdForOwner(ownerId: string, runId: string): Promise<AiRun | null> {
    const run = this.runs.get(runId);
    return run?.ownerId === ownerId ? run : null;
  }

  public async listActivityForProjectOwner(input: ListAiRunActivityInput): Promise<AiRunActivityRecordPage> {
    const selected = [...this.runs.values()]
      .filter((run) => run.ownerId === input.ownerId && run.projectId === input.projectId && matchesActivityFilter(run.status, input.filter))
      .filter((run) => !input.cursor || run.createdAt < input.cursor.createdAt || (run.createdAt.getTime() === input.cursor.createdAt.getTime() && run.id.localeCompare(input.cursor.id) > 0))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id));
    const page = selected.slice(0, input.limit + 1);
    const hasMore = page.length > input.limit;
    return { records: page.slice(0, input.limit).map((run) => ({ run, changeSet: null })), hasMore };
  }

  public async recordProviderUsage(ownerId: string, runId: string, usage: NonNullable<AiRun['providerUsage']>): Promise<AiRun | null> {
    return this.withLock(`usage:${runId}`, async () => {
      const run = this.runs.get(runId);
      if (!run || run.ownerId !== ownerId) {
        return null;
      }
      const current = run.providerUsage ?? {};
      const updated: AiRun = {
        ...run,
        providerUsage: {
          ...(current.promptTokens === undefined && isSafeProviderCount(usage.promptTokens) ? { promptTokens: usage.promptTokens } : current.promptTokens !== undefined ? { promptTokens: current.promptTokens } : {}),
          ...(current.completionTokens === undefined && isSafeProviderCount(usage.completionTokens) ? { completionTokens: usage.completionTokens } : current.completionTokens !== undefined ? { completionTokens: current.completionTokens } : {}),
          ...(current.totalTokens === undefined && isSafeProviderCount(usage.totalTokens) ? { totalTokens: usage.totalTokens } : current.totalTokens !== undefined ? { totalTokens: current.totalTokens } : {})
        }
      };
      this.runs.set(run.id, updated);
      return updated;
    });
  }

  public async listForRun(ownerId: string, projectId: string, runId: string): Promise<readonly ProjectTaskSuggestion[]> {
    const run = this.runs.get(runId);
    return run?.ownerId === ownerId && run.projectId === projectId ? this.taskSuggestions.get(runId) ?? [] : [];
  }

  public async recordDecision(input: DecisionUpdate): Promise<DecisionResult> {
    return this.withLock(`decision:${input.runId}`, async () => {
      const run = this.runs.get(input.runId);
      if (!run || run.ownerId !== input.ownerId) {
        throw new AiRunNotFoundError();
      }
      if (run.manifest.manifestHash !== input.manifestHash) {
        throw new AiRunManifestConflictError();
      }
      if (run.decisionIdempotencyKey) {
        if (run.decisionIdempotencyKey !== input.idempotencyKey || run.decisionFingerprint !== input.requestFingerprint) {
          throw new AiRunAlreadyDecidedError();
        }
        return { resource: run, replayed: true };
      }
      if (run.decision !== 'pending') {
        throw new AiRunAlreadyDecidedError();
      }
      const now = new Date();
      const updated: AiRun = input.decision === 'reject'
        ? {
          ...run,
          status: 'rejected',
          phase: 'decision',
          decision: 'rejected',
          decisionIdempotencyKey: input.idempotencyKey,
          decisionFingerprint: input.requestFingerprint,
          safeMessage: 'This run was not started. No project content was staged or sent to NVIDIA.',
          updatedAt: now
        }
        : {
          ...run,
          status: 'staging',
          phase: 'staging',
          decision: 'approved',
          ...(input.providerPermissionId ? { providerPermissionId: input.providerPermissionId } : {}),
          decisionIdempotencyKey: input.idempotencyKey,
          decisionFingerprint: input.requestFingerprint,
          safeMessage: 'Preparing a private run environment.',
          updatedAt: now
        };
      this.runs.set(updated.id, updated);
      return { resource: updated, replayed: false };
    });
  }

  public async save(run: AiRun): Promise<void> {
    const current = this.runs.get(run.id);
    if (!current || current.ownerId !== run.ownerId) {
      throw new AiRunNotFoundError();
    }
    this.runs.set(run.id, run);
  }

  public async reopenProviderPermissionDecision(input: { readonly ownerId: string; readonly runId: string; readonly permissionId: string }): Promise<AiRun | null> {
    return this.withLock(`start:${input.runId}`, async () => {
      const current = this.runs.get(input.runId);
      if (!current || current.ownerId !== input.ownerId || current.providerPermissionId !== input.permissionId
        || (current.status !== 'ready' && current.status !== 'queued') || current.providerTransmission !== 'not_started_confirmed') return null;
      const reopened: AiRun = {
        ...withoutRememberedPermissionApproval(current),
        status: 'pending_approval',
        phase: 'decision',
        decision: 'pending',
        sandboxReady: false,
        stagingItemCount: 0,
        safeMessage: 'The saved provider permission was revoked. Review this context before continuing.',
        updatedAt: new Date()
      };
      this.runs.set(reopened.id, reopened);
      return reopened;
    });
  }

  public async beginStart(input: StartRunUpdate): Promise<RunMutationResult> {
    return this.withLock(`start:${input.runId}`, async () => {
      const run = this.requireOwner(input.ownerId, input.runId);
      if (run.startIdempotencyKey) {
        if (run.startIdempotencyKey !== input.idempotencyKey || run.startFingerprint !== input.requestFingerprint) {
          throw new AiRunStateConflictError();
        }
        return { resource: run, replayed: true };
      }
      if (run.status !== 'ready') {
        throw new AiRunStateConflictError();
      }
      const updated: AiRun = {
        ...run,
        status: 'queued',
        phase: 'inference',
        startIdempotencyKey: input.idempotencyKey,
        startFingerprint: input.requestFingerprint,
        safeMessage: 'Starting assistant run.',
        updatedAt: new Date()
      };
      this.runs.set(updated.id, updated);
      return { resource: updated, replayed: false };
    });
  }

  public async abortStart(input: StartRunUpdate): Promise<boolean> {
    return this.withLock(`start:${input.runId}`, async () => {
      const run = this.runs.get(input.runId);
      if (!run) return false;
      const { startIdempotencyKey, startFingerprint, ...withoutStartIdempotency } = run;
      if (run.ownerId !== input.ownerId || run.status !== 'queued'
        || startIdempotencyKey !== input.idempotencyKey || startFingerprint !== input.requestFingerprint) {
        return false;
      }
      const ready: AiRun = {
        ...withoutStartIdempotency,
        status: 'ready',
        phase: 'runtime',
        safeMessage: 'Private run environment ready.',
        updatedAt: new Date()
      };
      this.runs.set(ready.id, ready);
      return true;
    });
  }

  public async markRunning(ownerId: string, runId: string): Promise<AiRun | null> {
    return this.withLock(`start:${runId}`, async () => {
      const run = this.runs.get(runId);
      if (!run || run.ownerId !== ownerId) {
        return null;
      }
      if (run.status !== 'queued' && run.status !== 'waiting_approval') {
        return run;
      }
      const updated: AiRun = { ...run, status: 'running', phase: 'inference', safeMessage: 'Assistant is working.', updatedAt: new Date() };
      this.runs.set(runId, updated);
      return updated;
    });
  }

  public async markWaitingApproval(ownerId: string, runId: string, safeMessage: string): Promise<AiRun | null> {
    return this.withLock(`start:${runId}`, async () => {
      const run = this.runs.get(runId);
      if (!run || run.ownerId !== ownerId) {
        return null;
      }
      if (run.status !== 'running' && run.status !== 'queued') {
        return run;
      }
      const updated: AiRun = { ...run, status: 'waiting_approval', phase: 'inference', safeMessage, updatedAt: new Date() };
      this.runs.set(runId, updated);
      return updated;
    });
  }

  public async requestCancellation(input: CancelRunUpdate): Promise<RunMutationResult> {
    return this.withLock(`start:${input.runId}`, async () => {
      const run = this.requireOwner(input.ownerId, input.runId);
      if (run.cancelIdempotencyKey) {
        if (run.cancelIdempotencyKey !== input.idempotencyKey || run.cancelFingerprint !== input.requestFingerprint) {
          throw new AiRunStateConflictError();
        }
        return { resource: run, replayed: true };
      }
      if (isTerminal(run.status)) {
        return { resource: run, replayed: true };
      }
      if (!['ready', 'queued', 'running', 'waiting_approval'].includes(run.status)) {
        throw new AiRunStateConflictError();
      }
      const immediate = run.status === 'ready' || run.status === 'queued';
      const updated: AiRun = {
        ...run,
        status: immediate ? 'cancelled' : 'cancel_requested',
        phase: 'terminal',
        cancelIdempotencyKey: input.idempotencyKey,
        cancelFingerprint: input.requestFingerprint,
        cleanup: immediate ? 'complete' : run.cleanup,
        safeMessage: immediate ? 'Run cancelled. No further assistant work will be applied.' : 'Stopping assistant run.',
        updatedAt: new Date()
      };
      this.runs.set(updated.id, updated);
      return { resource: updated, replayed: false };
    });
  }

  public async completeRun(input: CompleteRunUpdate): Promise<AiRun | null> {
    return this.withLock(`start:${input.runId}`, async () => {
      const run = this.runs.get(input.runId);
      if (!run || run.ownerId !== input.ownerId) {
        return null;
      }
      if (isTerminal(run.status) || run.status === 'cancel_requested') {
        return run;
      }
      if (!['queued', 'running', 'waiting_approval'].includes(run.status)) {
        return run;
      }
      const text = input.assistantText ?? '';
      const drafts = input.status === 'succeeded' ? normalizeTaskSuggestionDrafts(input.taskSuggestions ?? []) : [];
      const now = new Date();
      const suggestions: readonly ProjectTaskSuggestion[] = drafts.map((draft) => ({
        id: randomUUID(),
        projectId: run.projectId,
        runId: run.id,
        conversationId: run.conversationId,
        title: draft.title,
        details: draft.details ?? null,
        subtasks: draft.subtasks ?? [],
        status: 'pending',
        version: 1,
        taskId: null,
        source: { kind: 'assistant', label: 'Suggested by the assistant' },
        createdAt: now,
        resolvedAt: null
      }));
      const assistantFields = input.assistantText === undefined
        ? {}
        : { assistantComplete: input.assistantComplete ?? (input.status === 'succeeded'), assistantContentLength: text.length };
      const updated: AiRun = {
        ...run,
        status: input.status,
        phase: input.status === 'review_required' ? 'review' : 'terminal',
        cleanup: input.cleanup ?? (input.status === 'succeeded' ? 'complete' : run.cleanup),
        providerTransmission: input.providerTransmission ?? run.providerTransmission,
        ...assistantFields,
        safeMessage: input.safeMessage,
        updatedAt: new Date()
      };
      this.runs.set(updated.id, updated);
      if (suggestions.length > 0) {
        this.taskSuggestions.set(updated.id, suggestions);
      }
      return updated;
    });
  }

  public async markCancelled(ownerId: string, runId: string): Promise<AiRun | null> {
    return this.withLock(`start:${runId}`, async () => {
      const run = this.runs.get(runId);
      if (!run || run.ownerId !== ownerId) {
        return null;
      }
      if (run.status !== 'cancel_requested') {
        return run;
      }
      const updated: AiRun = { ...run, status: 'cancelled', phase: 'terminal', cleanup: 'complete', safeMessage: 'Run cancelled. No further assistant work will be applied.', updatedAt: new Date() };
      this.runs.set(runId, updated);
      return updated;
    });
  }

  public async markReviewRequired(ownerId: string, runId: string, safeMessage: string): Promise<AiRun | null> {
    return this.withLock(`start:${runId}`, async () => {
      const run = this.runs.get(runId);
      if (!run || run.ownerId !== ownerId) {
        return null;
      }
      if (!['queued', 'running', 'waiting_approval', 'cancel_requested'].includes(run.status)) {
        return run;
      }
      const updated: AiRun = { ...run, status: 'review_required', phase: 'review', cleanup: 'unknown', providerTransmission: run.providerTransmission === 'transmitted_confirmed' ? 'transmitted_confirmed' : 'unknown', safeMessage, updatedAt: new Date() };
      this.runs.set(runId, updated);
      return updated;
    });
  }

  public async withRunProjection(ownerId: string, runId: string, projection: (run: AiRun) => void): Promise<boolean> {
    return this.withLock(`start:${runId}`, async () => {
      const run = this.runs.get(runId);
      if (!run || run.ownerId !== ownerId || isProjectionBlocked(run.status)) {
        return false;
      }
      projection(run);
      return true;
    });
  }

  private requireOwner(ownerId: string, runId: string): AiRun {
    const run = this.runs.get(runId);
    if (!run || run.ownerId !== ownerId) {
      throw new AiRunNotFoundError();
    }
    return run;
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }

  private idempotencyKey(ownerId: string, projectId: string, key: string): string {
    return `${ownerId}:${projectId}:ai-run:${key}`;
  }

  private createLockKey(ownerId: string, projectId: string, key: string): string {
    return `create:${this.idempotencyKey(ownerId, projectId, key)}`;
  }
}

function withoutRememberedPermissionApproval(run: AiRun): Omit<AiRun, 'providerPermissionId' | 'runtimeKind' | 'runtimeReference' | 'decisionIdempotencyKey' | 'decisionFingerprint' | 'startIdempotencyKey' | 'startFingerprint'> {
  const omitted = new Set(['providerPermissionId', 'runtimeKind', 'runtimeReference', 'decisionIdempotencyKey', 'decisionFingerprint', 'startIdempotencyKey', 'startFingerprint']);
  return Object.fromEntries(Object.entries(run).filter(([key]) => !omitted.has(key))) as Omit<AiRun, 'providerPermissionId' | 'runtimeKind' | 'runtimeReference' | 'decisionIdempotencyKey' | 'decisionFingerprint' | 'startIdempotencyKey' | 'startFingerprint'>;
}

function matchesActivityFilter(status: AiRun['status'], filter: ListAiRunActivityInput['filter']): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return ['pending_approval', 'staging', 'ready', 'queued', 'running', 'waiting_approval', 'cancel_requested'].includes(status);
  if (filter === 'succeeded') return status === 'succeeded';
  if (filter === 'attention') return status === 'failed' || status === 'blocked' || status === 'review_required';
  if (filter === 'cancelled') return status === 'cancelled';
  return status === 'rejected';
}

function isSafeProviderCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function isTerminal(status: AiRun['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'blocked' || status === 'cancelled' || status === 'review_required' || status === 'rejected';
}

function isProjectionBlocked(status: AiRun['status']): boolean {
  return status === 'cancel_requested' || isTerminal(status);
}
