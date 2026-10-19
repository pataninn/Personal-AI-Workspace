import { randomUUID } from 'node:crypto';

import {
  ChangeSetAlreadyDecidedError,
  ChangeSetConflictError,
  ChangeSetIdempotencyReusedError,
  ChangeSetNotFoundError
} from '@/modules/ai-runs/domain/change-errors';
import type {
  ChangeSetDecisionResult,
  ChangeSetDecisionUpdate,
  CreateProposedChangeSetRecord,
  PolicyAuthorizedChangeSetApplyClaim,
  ProposedChangeSet
} from '@/modules/ai-runs/domain/change-types';
import type { IProposedChangeSetRepository } from '@/modules/ai-runs/repositories/change-set-repository';
import type { ListProjectFileHistoryInput, ProjectFileHistoryRecord, ProjectFileHistoryRecordPage } from '@/modules/ai-runs/domain/file-history-types';

export class InMemoryProposedChangeSetRepository implements IProposedChangeSetRepository {
  private readonly changeSets = new Map<string, ProposedChangeSet>();
  private readonly locks = new Map<string, Promise<void>>();

  public async create(input: CreateProposedChangeSetRecord): Promise<ProposedChangeSet> {
    return this.withLock(`create:${input.ownerId}:${input.runId}`, async () => {
      const existing = [...this.changeSets.values()].find((candidate) => candidate.ownerId === input.ownerId && candidate.runId === input.runId);
      if (existing) {
        if (existing.proposalHash !== input.proposalHash) {
          throw new ChangeSetConflictError('This run already has a different immutable change set.');
        }
        return existing;
      }
      const now = new Date();
      const changeSet: ProposedChangeSet = {
        id: randomUUID(),
        runId: input.runId,
        ownerId: input.ownerId,
        projectId: input.projectId,
        proposalHash: input.proposalHash,
        status: 'awaiting_approval',
        decision: 'pending',
        operations: input.operations,
        counts: input.counts,
        totalSizeBytes: input.totalSizeBytes,
        totalLineCount: input.totalLineCount,
        previewLimitBytes: input.previewLimitBytes,
        previewLimitLines: input.previewLimitLines,
        fakeRuntime: input.fakeRuntime,
        safeMessage: 'Review the proposed changes before applying them.',
        createdAt: now,
        updatedAt: now
      };
      this.changeSets.set(changeSet.id, changeSet);
      return changeSet;
    });
  }

  public async findByRunForOwner(ownerId: string, runId: string): Promise<ProposedChangeSet | null> {
    return [...this.changeSets.values()].find((candidate) => candidate.ownerId === ownerId && candidate.runId === runId) ?? null;
  }

  public async listFileHistoryForProjectOwner(input: ListProjectFileHistoryInput): Promise<ProjectFileHistoryRecordPage> {
    const records: ProjectFileHistoryRecord[] = [...this.changeSets.values()]
      .filter((changeSet) => changeSet.ownerId === input.ownerId && changeSet.projectId === input.projectId)
      .flatMap((changeSet) => changeSet.operations.flatMap((operation, operationIndex) => {
        const matchedPath = operation.path === input.path ? operation.path : operation.destinationPath === input.path ? operation.destinationPath : undefined;
        if (!matchedPath) return [];
        const result = changeSet.result?.operations.find((candidate) => candidate.operationId === operation.operationId);
        if (input.outcome === 'applied' && result?.status !== 'applied') return [];
        return [{
          changeSetId: changeSet.id,
          projectId: changeSet.projectId,
          runId: changeSet.runId,
          conversationId: null,
          operationId: operation.operationId,
          operationIndex,
          operation: operation.operation,
          matchedPath,
          path: operation.path,
          ...(operation.destinationPath ? { destinationPath: operation.destinationPath } : {}),
          summary: operation.summary,
          changeSetStatus: changeSet.status,
          operationStatus: result?.status ?? null,
          backupStatus: result?.backup ?? historyBackupStatus(changeSet.status, operation.backupRequired),
          createdAt: changeSet.createdAt,
          updatedAt: changeSet.updatedAt
        }];
      }))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || left.changeSetId.localeCompare(right.changeSetId) || left.operationIndex - right.operationIndex)
      .filter((record) => !input.cursor || record.createdAt < input.cursor.createdAt ||
        (record.createdAt.getTime() === input.cursor.createdAt.getTime() && (record.changeSetId > input.cursor.changeSetId || (record.changeSetId === input.cursor.changeSetId && record.operationIndex > input.cursor.operationIndex))));
    return { records: records.slice(0, input.limit), hasMore: records.length > input.limit };
  }

  public async recordDecision(input: ChangeSetDecisionUpdate): Promise<ChangeSetDecisionResult> {
    return this.withLock(`decision:${input.runId}`, async () => {
      const changeSet = await this.findByRunForOwner(input.ownerId, input.runId);
      if (!changeSet) {
        throw new ChangeSetNotFoundError();
      }
      if (changeSet.proposalHash !== input.proposalHash) {
        throw new ChangeSetConflictError();
      }
      if (changeSet.decisionIdempotencyKey) {
        if (changeSet.decisionIdempotencyKey !== input.idempotencyKey || changeSet.decisionFingerprint !== input.requestFingerprint) {
          throw new ChangeSetIdempotencyReusedError();
        }
        return { resource: changeSet, replayed: true };
      }
      if (changeSet.decision !== 'pending' || changeSet.status !== 'awaiting_approval') {
        throw new ChangeSetAlreadyDecidedError();
      }
      const updated: ProposedChangeSet = input.decision === 'reject'
        ? { ...changeSet, status: 'rejected', decision: 'rejected', decisionIdempotencyKey: input.idempotencyKey, decisionFingerprint: input.requestFingerprint, safeMessage: 'Change set rejected. No project files were changed.', updatedAt: new Date() }
        : { ...changeSet, status: 'applying', decision: 'approved', decisionIdempotencyKey: input.idempotencyKey, decisionFingerprint: input.requestFingerprint, safeMessage: 'Applying approved changes.', updatedAt: new Date() };
      this.changeSets.set(updated.id, updated);
      return { resource: updated, replayed: false };
    });
  }

  public async claimPolicyAuthorizedApply(input: PolicyAuthorizedChangeSetApplyClaim): Promise<ChangeSetDecisionResult> {
    return this.withLock(`decision:${input.runId}`, async () => {
      const changeSet = await this.findByRunForOwner(input.ownerId, input.runId);
      if (!changeSet || changeSet.projectId !== input.projectId) throw new ChangeSetNotFoundError();
      if (changeSet.proposalHash !== input.proposalHash) throw new ChangeSetConflictError();
      if (changeSet.decisionIdempotencyKey) {
        if (changeSet.decisionIdempotencyKey !== input.idempotencyKey || changeSet.decisionFingerprint !== input.requestFingerprint) throw new ChangeSetIdempotencyReusedError();
        return { resource: changeSet, replayed: true };
      }
      if (changeSet.decision !== 'pending' || changeSet.status !== 'awaiting_approval') throw new ChangeSetAlreadyDecidedError();
      const updated: ProposedChangeSet = {
        ...changeSet,
        status: 'applying',
        decision: 'policy_authorized',
        decisionIdempotencyKey: input.idempotencyKey,
        decisionFingerprint: input.requestFingerprint,
        safeMessage: 'Applying workspace-policy authorized changes.',
        updatedAt: new Date()
      };
      this.changeSets.set(updated.id, updated);
      return { resource: updated, replayed: false };
    });
  }

  public async save(changeSet: ProposedChangeSet): Promise<void> {
    const current = this.changeSets.get(changeSet.id);
    if (!current || current.ownerId !== changeSet.ownerId || current.runId !== changeSet.runId) {
      throw new ChangeSetNotFoundError();
    }
    this.changeSets.set(changeSet.id, changeSet);
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
}

function historyBackupStatus(status: ProposedChangeSet['status'], backupRequired: boolean): 'not_required' | 'pending' | 'not_created' | 'unknown' {
  if (!backupRequired) return 'not_required';
  if (status === 'applying') return 'pending';
  if (status === 'stale' || status === 'needs_manual_review') return 'unknown';
  return 'not_created';
}
