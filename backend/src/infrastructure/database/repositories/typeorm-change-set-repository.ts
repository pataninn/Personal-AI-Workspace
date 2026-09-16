import type { DataSource, QueryRunner } from 'typeorm';

import {
  ChangeSetAlreadyDecidedError,
  ChangeSetConflictError,
  ChangeSetIdempotencyReusedError,
  ChangeSetNotFoundError
} from '@/modules/ai-runs/domain/change-errors';
import type {
  ChangeSetDecisionResult,
  ChangeSetDecisionUpdate,
  ChangeSetResult,
  ChangeSetStatus,
  CreateProposedChangeSetRecord,
  ProposedChangeOperation,
  ProposedChangeSet
} from '@/modules/ai-runs/domain/change-types';
import type { IProposedChangeSetRepository } from '@/modules/ai-runs/repositories/change-set-repository';
import { ProjectArchivedError } from '@/modules/conversations/domain/conversation-errors';

interface ChangeSetRow {
  readonly id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly proposal_hash: string;
  readonly status: ChangeSetStatus;
  readonly decision: ProposedChangeSet['decision'];
  readonly operations: unknown;
  readonly total_size_bytes: number;
  readonly total_line_count: number;
  readonly preview_limit_bytes: number;
  readonly preview_limit_lines: number;
  readonly fake_runtime: boolean;
  readonly backup_checkpoints: unknown;
  readonly result: unknown;
  readonly decision_idempotency_key: string | null;
  readonly decision_fingerprint: string | null;
  readonly safe_message: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

export class TypeOrmProposedChangeSetRepository implements IProposedChangeSetRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async create(input: CreateProposedChangeSetRecord): Promise<ProposedChangeSet> {
    const queryRunner = await this.startTransaction();
    try {
      await lockRun(queryRunner, input.runId);
      const existing = await this.findByRun(queryRunner, input.ownerId, input.runId);
      if (existing) {
        if (existing.proposal_hash !== input.proposalHash) {
          throw new ChangeSetConflictError('This run already has a different immutable change set.');
        }
        await queryRunner.commitTransaction();
        return toChangeSet(existing);
      }
      const rows: readonly ChangeSetRow[] = await queryRunner.query(
        `INSERT INTO "ai_run_change_sets" ("owner_id", "project_id", "run_id", "proposal_hash", "operations", "total_size_bytes", "total_line_count", "preview_limit_bytes", "preview_limit_lines", "fake_runtime", "backup_checkpoints", "safe_message")
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb, $12)
         RETURNING *`,
        [input.ownerId, input.projectId, input.runId, input.proposalHash, JSON.stringify(input.operations), input.totalSizeBytes, input.totalLineCount, input.previewLimitBytes, input.previewLimitLines, input.fakeRuntime, '[]', 'Review the proposed changes before applying them.']
      );
      const row = rows[0];
      if (!row) {
        throw new ChangeSetNotFoundError();
      }
      await queryRunner.commitTransaction();
      return toChangeSet(row);
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async findByRunForOwner(ownerId: string, runId: string): Promise<ProposedChangeSet | null> {
    const rows: readonly ChangeSetRow[] = await this.dataSource.query(
      'SELECT * FROM "ai_run_change_sets" WHERE "owner_id" = $1 AND "run_id" = $2 LIMIT 1',
      [ownerId, runId]
    );
    return rows[0] ? toChangeSet(rows[0]) : null;
  }

  public async recordDecision(input: ChangeSetDecisionUpdate): Promise<ChangeSetDecisionResult> {
    const queryRunner = await this.startTransaction();
    try {
      const row = await this.findForUpdate(queryRunner, input.ownerId, input.runId);
      if (!row) {
        throw new ChangeSetNotFoundError();
      }
      if (row.proposal_hash !== input.proposalHash) {
        throw new ChangeSetConflictError();
      }
      if (row.decision_idempotency_key) {
        if (row.decision_idempotency_key !== input.idempotencyKey || row.decision_fingerprint !== input.requestFingerprint) {
          throw new ChangeSetIdempotencyReusedError();
        }
        await queryRunner.commitTransaction();
        return { resource: toChangeSet(row), replayed: true };
      }
      if (row.decision !== 'pending' || row.status !== 'awaiting_approval') {
        throw new ChangeSetAlreadyDecidedError();
      }
      await assertProjectActive(queryRunner, input.ownerId, row.project_id);
      const status = input.decision === 'approve' ? 'applying' : 'rejected';
      const decision = input.decision === 'approve' ? 'approved' : 'rejected';
      const safeMessage = input.decision === 'approve' ? 'Applying approved changes.' : 'Change set rejected. No project files were changed.';
      const rows: readonly ChangeSetRow[] = await queryRunner.query(
        `UPDATE "ai_run_change_sets" SET "status" = $1, "decision" = $2, "decision_idempotency_key" = $3, "decision_fingerprint" = $4, "safe_message" = $5, "updated_at" = now()
         WHERE "owner_id" = $6 AND "run_id" = $7 RETURNING *`,
        [status, decision, input.idempotencyKey, input.requestFingerprint, safeMessage, input.ownerId, input.runId]
      );
      const updated = rows[0];
      if (!updated) {
        throw new ChangeSetNotFoundError();
      }
      await queryRunner.commitTransaction();
      return { resource: toChangeSet(updated), replayed: false };
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async save(changeSet: ProposedChangeSet): Promise<void> {
    const rows: readonly ChangeSetRow[] = await this.dataSource.query(
      `UPDATE "ai_run_change_sets" SET "status" = $1, "decision" = $2, "operations" = $3::jsonb, "backup_checkpoints" = $4::jsonb, "result" = $5::jsonb, "safe_message" = $6, "updated_at" = now()
       WHERE "owner_id" = $7 AND "run_id" = $8 AND "id" = $9 RETURNING *`,
      [changeSet.status, changeSet.decision, JSON.stringify(changeSet.operations), JSON.stringify(changeSet.backupCheckpoints ?? []), changeSet.result ? JSON.stringify(changeSet.result) : null, changeSet.safeMessage, changeSet.ownerId, changeSet.runId, changeSet.id]
    );
    if (!rows[0]) {
      throw new ChangeSetNotFoundError();
    }
  }

  private async startTransaction(): Promise<QueryRunner> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    return queryRunner;
  }

  private async findByRun(queryRunner: QueryRunner, ownerId: string, runId: string): Promise<ChangeSetRow | null> {
    const rows: readonly ChangeSetRow[] = await queryRunner.query('SELECT * FROM "ai_run_change_sets" WHERE "owner_id" = $1 AND "run_id" = $2 LIMIT 1', [ownerId, runId]);
    return rows[0] ?? null;
  }

  private async findForUpdate(queryRunner: QueryRunner, ownerId: string, runId: string): Promise<ChangeSetRow | null> {
    const rows: readonly ChangeSetRow[] = await queryRunner.query('SELECT * FROM "ai_run_change_sets" WHERE "owner_id" = $1 AND "run_id" = $2 LIMIT 1 FOR UPDATE', [ownerId, runId]);
    return rows[0] ?? null;
  }
}

async function lockRun(queryRunner: QueryRunner, runId: string): Promise<void> {
  await queryRunner.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`change-set:${runId}`]);
}

async function assertProjectActive(queryRunner: QueryRunner, ownerId: string, projectId: string): Promise<void> {
  const rows: readonly { readonly status: 'active' | 'archived' }[] = await queryRunner.query('SELECT "status" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1 FOR UPDATE', [ownerId, projectId]);
  if (!rows[0] || rows[0].status === 'archived') {
    throw new ProjectArchivedError();
  }
}

function toChangeSet(row: ChangeSetRow): ProposedChangeSet {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    runId: row.run_id,
    proposalHash: row.proposal_hash,
    status: row.status,
    decision: row.decision,
    operations: parseOperations(row.operations),
    totalSizeBytes: row.total_size_bytes,
    totalLineCount: row.total_line_count,
    previewLimitBytes: row.preview_limit_bytes,
    previewLimitLines: row.preview_limit_lines,
    fakeRuntime: row.fake_runtime,
    ...(parseBackupCheckpoints(row.backup_checkpoints).length > 0 ? { backupCheckpoints: parseBackupCheckpoints(row.backup_checkpoints) } : {}),
    counts: countOperations(parseOperations(row.operations)),
    ...(row.result ? { result: parseResult(row.result) } : {}),
    ...(row.decision_idempotency_key ? { decisionIdempotencyKey: row.decision_idempotency_key } : {}),
    ...(row.decision_fingerprint ? { decisionFingerprint: row.decision_fingerprint } : {}),
    safeMessage: row.safe_message,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

function parseOperations(value: unknown): readonly ProposedChangeOperation[] {
  return Array.isArray(value) ? value.filter(isOperation) : [];
}

function isOperation(value: unknown): value is ProposedChangeOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.operationId === 'string' && typeof candidate.operation === 'string' && typeof candidate.path === 'string' && typeof candidate.summary === 'string';
}

function parseResult(value: unknown): NonNullable<ProposedChangeSet['result']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The stored change-set result is invalid.');
  }
  return value as NonNullable<ProposedChangeSet['result']>;
}

function parseBackupCheckpoints(value: unknown): NonNullable<ProposedChangeSet['backupCheckpoints']> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((candidate): candidate is NonNullable<ProposedChangeSet['backupCheckpoints']>[number] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const value = candidate as Record<string, unknown>;
    return typeof value.reference === 'string' && typeof value.operationId === 'string' && typeof value.path === 'string' && typeof value.sizeBytes === 'number' && typeof value.contentSha256 === 'string' && typeof value.createdAt === 'string';
  }).map((checkpoint) => ({ ...checkpoint, createdAt: new Date(checkpoint.createdAt) }));
}

function countOperations(operations: readonly ProposedChangeOperation[]): ProposedChangeSet['counts'] {
  return {
    total: operations.length,
    creates: operations.filter((operation) => operation.operation === 'create').length,
    edits: operations.filter((operation) => operation.operation === 'edit').length,
    overwrites: operations.filter((operation) => operation.operation === 'overwrite').length,
    renames: operations.filter((operation) => operation.operation === 'rename').length,
    deletes: operations.filter((operation) => operation.operation === 'delete').length,
    destructive: operations.filter((operation) => operation.backupRequired).length
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
