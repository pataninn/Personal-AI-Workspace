import { randomUUID } from 'node:crypto';

import {
  AiRunAlreadyDecidedError,
  AiRunIdempotencyReusedError,
  AiRunManifestConflictError,
  AiRunNotFoundError
} from '@/modules/ai-runs/domain/ai-run-errors';
import type {
  AiRun,
  CreateAiRunRecord,
  DecisionResult,
  DecisionUpdate
} from '@/modules/ai-runs/domain/ai-run-types';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';

interface IdempotentRunRecord {
  readonly fingerprint: string;
  readonly resourceId: string;
}

export class InMemoryAiRunRepository implements IAiRunRepository {
  private readonly runs = new Map<string, AiRun>();
  private readonly idempotency = new Map<string, IdempotentRunRecord>();
  private readonly locks = new Map<string, Promise<void>>();

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
      const run: AiRun = {
        id: randomUUID(),
        ownerId: input.ownerId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        request: input.request,
        relativeRoot: input.relativeRoot,
        requestedPaths: [...input.requestedPaths],
        manifest: input.manifest,
        manifestInvalidated: false,
        status: 'pending_approval',
        phase: 'decision',
        decision: 'pending',
        cleanup: 'not_started',
        providerTransmission: 'not_started_confirmed',
        stagingItemCount: 0,
        sandboxReady: false,
        safeMessage: 'Review the provider disclosure before continuing.',
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
