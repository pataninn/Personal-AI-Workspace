import type { DataSource, QueryRunner } from 'typeorm';
import { lockProjectWriteState } from '@/infrastructure/database/project-removal-write-barrier';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { fixedContentScope, resultContentScope } from '@/infrastructure/database/storage-content-projections';

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
  PolicyAuthorizedChangeSetApplyClaim,
  ProposedChangeOperation,
  ProposedChangeSet
} from '@/modules/ai-runs/domain/change-types';
import type { IProposedChangeSetRepository } from '@/modules/ai-runs/repositories/change-set-repository';
import type { ListProjectFileHistoryInput, ProjectFileHistoryRecord, ProjectFileHistoryRecordPage } from '@/modules/ai-runs/domain/file-history-types';
import { ProjectArchivedError } from '@/modules/conversations/domain/conversation-errors';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';

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

interface FileHistoryRow {
  readonly change_set_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly conversation_id: string | null;
  readonly operation_id: string;
  readonly operation_index: number | string;
  readonly operation: ProjectFileHistoryRecord['operation'];
  readonly matched_path: string;
  readonly path: string;
  readonly destination_path: string | null;
  readonly summary: string;
  readonly change_set_status: ProjectFileHistoryRecord['changeSetStatus'];
  readonly operation_status: ProjectFileHistoryRecord['operationStatus'];
  readonly backup_status: ProjectFileHistoryRecord['backupStatus'] | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

export class TypeOrmProposedChangeSetRepository implements IProposedChangeSetRepository {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly storageAccounting = new TypeOrmStorageContentAccounting(dataSource)
  ) {}

  public async create(input: CreateProposedChangeSetRecord): Promise<ProposedChangeSet> {
    const queryRunner = await this.startTransaction();
    try {
      const result = await this.storageAccounting.runMutation(queryRunner, input.ownerId, async () => {
        await assertPrincipalActive(queryRunner, input.ownerId);
        await lockRun(queryRunner, input.runId);
        const existing = await this.findByRun(queryRunner, input.ownerId, input.runId);
        if (existing) {
          if (existing.proposal_hash !== input.proposalHash) throw new ChangeSetConflictError('This run already has a different immutable change set.');
          return toChangeSet(existing);
        }
        await assertProjectActive(queryRunner, input.ownerId, input.projectId);
        const rows: readonly ChangeSetRow[] = await queryRunner.query(
          `INSERT INTO "ai_run_change_sets" ("owner_id", "project_id", "run_id", "proposal_hash", "operations", "operation_paths", "total_size_bytes", "total_line_count", "preview_limit_bytes", "preview_limit_lines", "fake_runtime", "backup_checkpoints", "safe_message")
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $8, $9, $10, $11, $12::jsonb, $13)
           RETURNING *`,
          [input.ownerId, input.projectId, input.runId, input.proposalHash, JSON.stringify(input.operations), operationPaths(input.operations), input.totalSizeBytes, input.totalLineCount, input.previewLimitBytes, input.previewLimitLines, input.fakeRuntime, '[]', 'Review the proposed changes before applying them.']
        );
        const row = rows[0];
        if (!row) throw new ChangeSetNotFoundError();
        return toChangeSet(row);
      }, resultContentScope((value: ProposedChangeSet) => [{ entity: 'ai_run_change_sets', id: value.id }]));
      await queryRunner.commitTransaction();
      return result;
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
      const result = await this.storageAccounting.runMutation(queryRunner, input.ownerId, async () => {
        await assertPrincipalActive(queryRunner, input.ownerId);
        const row = await this.findForUpdate(queryRunner, input.ownerId, input.runId);
        if (!row) throw new ChangeSetNotFoundError();
        if (row.proposal_hash !== input.proposalHash) throw new ChangeSetConflictError();
        if (row.decision_idempotency_key) {
          if (row.decision_idempotency_key !== input.idempotencyKey || row.decision_fingerprint !== input.requestFingerprint) throw new ChangeSetIdempotencyReusedError();
          return { resource: toChangeSet(row), replayed: true };
        }
        if (row.decision !== 'pending' || row.status !== 'awaiting_approval') throw new ChangeSetAlreadyDecidedError();
        await assertProjectActive(queryRunner, input.ownerId, row.project_id);
        const status = input.decision === 'approve' ? 'applying' : 'rejected';
        const decision = input.decision === 'approve' ? 'approved' : 'rejected';
        const safeMessage = input.decision === 'approve' ? 'Applying approved changes.' : 'Change set rejected. No project files were changed.';
        const rows: readonly ChangeSetRow[] = await queryRunner.query(
          `UPDATE "ai_run_change_sets" SET "status" = $1, "decision" = $2, "decision_idempotency_key" = $3, "decision_fingerprint" = $4, "safe_message" = $5, "updated_at" = now()
           WHERE "owner_id" = $6 AND "run_id" = $7 RETURNING *`,
          [status, decision, input.idempotencyKey, input.requestFingerprint, safeMessage, input.ownerId, input.runId]
        );
        const updated = returningRow(rows);
        if (!updated) throw new ChangeSetNotFoundError();
        return { resource: toChangeSet(updated), replayed: false };
      }, resultContentScope((value: ChangeSetDecisionResult) => [{ entity: 'ai_run_change_sets', id: value.resource.id }]));
      await queryRunner.commitTransaction();
      return result;
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async claimPolicyAuthorizedApply(input: PolicyAuthorizedChangeSetApplyClaim): Promise<ChangeSetDecisionResult> {
    const queryRunner = await this.startTransaction();
    try {
      const result = await this.storageAccounting.runMutation(queryRunner, input.ownerId, async () => {
        await assertPrincipalActive(queryRunner, input.ownerId);
        await assertPolicyAuthorizedRun(queryRunner, input);
        await assertWorkspacePolicyCurrent(queryRunner, input);
        await assertProjectActive(queryRunner, input.ownerId, input.projectId);
        const row = await this.findForUpdate(queryRunner, input.ownerId, input.runId);
        if (!row) throw new ChangeSetNotFoundError();
        if (row.project_id !== input.projectId || row.proposal_hash !== input.proposalHash) throw new ChangeSetConflictError();
        if (row.decision_idempotency_key) {
          if (row.decision_idempotency_key !== input.idempotencyKey || row.decision_fingerprint !== input.requestFingerprint) throw new ChangeSetIdempotencyReusedError();
          return { resource: toChangeSet(row), replayed: true };
        }
        if (row.decision !== 'pending' || row.status !== 'awaiting_approval') throw new ChangeSetAlreadyDecidedError();
        const rows: readonly ChangeSetRow[] = await queryRunner.query(
          `UPDATE "ai_run_change_sets" SET "status" = 'applying', "decision" = 'policy_authorized',
             "decision_idempotency_key" = $1, "decision_fingerprint" = $2,
             "safe_message" = 'Applying workspace-policy authorized changes.', "updated_at" = now()
           WHERE "owner_id" = $3 AND "project_id" = $4 AND "run_id" = $5 AND "id" = $6 RETURNING *`,
          [input.idempotencyKey, input.requestFingerprint, input.ownerId, input.projectId, input.runId, row.id]
        );
        const updated = returningRow(rows);
        if (!updated) throw new ChangeSetNotFoundError();
        return { resource: toChangeSet(updated), replayed: false };
      }, resultContentScope((value: ChangeSetDecisionResult) => [{ entity: 'ai_run_change_sets', id: value.resource.id }]));
      await queryRunner.commitTransaction();
      return result;
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async save(changeSet: ProposedChangeSet): Promise<void> {
    const queryRunner = await this.startTransaction();
    try {
      await this.storageAccounting.runMutation(queryRunner, changeSet.ownerId, async () => {
        await assertProjectActive(queryRunner, changeSet.ownerId, changeSet.projectId);
        const rows: readonly ChangeSetRow[] = await queryRunner.query(
          `UPDATE "ai_run_change_sets" SET "status" = $1, "decision" = $2, "operations" = $3::jsonb, "operation_paths" = $4::text[], "backup_checkpoints" = $5::jsonb, "result" = $6::jsonb, "safe_message" = $7, "updated_at" = now()
           WHERE "owner_id" = $8 AND "run_id" = $9 AND "id" = $10 RETURNING *`,
          [changeSet.status, changeSet.decision, JSON.stringify(changeSet.operations), operationPaths(changeSet.operations), JSON.stringify(changeSet.backupCheckpoints ?? []), changeSet.result ? JSON.stringify(changeSet.result) : null, changeSet.safeMessage, changeSet.ownerId, changeSet.runId, changeSet.id]
        );
        if (!returningRow(rows)) throw new ChangeSetNotFoundError();
        return undefined;
      }, fixedContentScope([{ entity: 'ai_run_change_sets', id: changeSet.id }]));
      await queryRunner.commitTransaction();
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async listFileHistoryForProjectOwner(input: ListProjectFileHistoryInput): Promise<ProjectFileHistoryRecordPage> {
    const cursor = input.cursor;
    const rows: readonly FileHistoryRow[] = await this.dataSource.query(
      `SELECT change_set."id" AS change_set_id, change_set."project_id", change_set."run_id", ai_run."conversation_id",
         operation.item->>'operationId' AS operation_id, (operation.ordinality - 1)::integer AS operation_index,
         operation.item->>'operation' AS operation,
         CASE WHEN operation.item->>'path' = $3 THEN operation.item->>'path' ELSE operation.item->>'destinationPath' END AS matched_path,
         operation.item->>'path' AS path, operation.item->>'destinationPath' AS destination_path,
         operation.item->>'summary' AS summary, change_set."status" AS change_set_status,
         result.item->>'status' AS operation_status,
         COALESCE(result.item->>'backup', CASE
           WHEN operation.item->>'backupRequired' <> 'true' THEN 'not_required'
           WHEN change_set."status" = 'applying' THEN 'pending'
           WHEN change_set."status" IN ('stale', 'needs_manual_review') THEN 'unknown'
           ELSE 'not_created'
         END) AS backup_status,
         change_set."created_at", change_set."updated_at"
       FROM "ai_run_change_sets" AS change_set
       JOIN "ai_runs" AS ai_run ON ai_run."id" = change_set."run_id" AND ai_run."owner_id" = change_set."owner_id" AND ai_run."project_id" = change_set."project_id"
       CROSS JOIN LATERAL jsonb_array_elements(change_set."operations") WITH ORDINALITY AS operation(item, ordinality)
       LEFT JOIN LATERAL (
         SELECT item FROM jsonb_array_elements(COALESCE(change_set."result"->'operations', '[]'::jsonb)) AS results(item)
         WHERE item->>'operationId' = operation.item->>'operationId' LIMIT 1
       ) AS result ON true
       WHERE change_set."owner_id" = $1 AND change_set."project_id" = $2
         AND change_set."operation_paths" @> ARRAY[$3]::text[]
         AND (operation.item->>'path' = $3 OR operation.item->>'destinationPath' = $3)
         AND ($4::text = 'all' OR result.item->>'status' = 'applied')
         AND ($5::timestamptz IS NULL OR change_set."created_at" < $5 OR
           (change_set."created_at" = $5 AND (change_set."id" > $6 OR (change_set."id" = $6 AND operation.ordinality - 1 > $7))))
       ORDER BY change_set."created_at" DESC, change_set."id" ASC, operation.ordinality ASC
       LIMIT $8`,
      [input.ownerId, input.projectId, input.path, input.outcome, cursor?.createdAt ?? null, cursor?.changeSetId ?? null, cursor?.operationIndex ?? -1, input.limit + 1]
    );
    return { records: rows.slice(0, input.limit).map(toFileHistoryRecord), hasMore: rows.length > input.limit };
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

function operationPaths(operations: readonly ProposedChangeOperation[]): string[] {
  return [...new Set(operations.flatMap((operation) => [operation.path, ...(operation.destinationPath ? [operation.destinationPath] : [])]))];
}

function toFileHistoryRecord(row: FileHistoryRow): ProjectFileHistoryRecord {
  return {
    changeSetId: row.change_set_id,
    projectId: row.project_id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    operationId: row.operation_id,
    operationIndex: Number(row.operation_index),
    operation: row.operation,
    matchedPath: row.matched_path,
    path: row.path,
    ...(row.destination_path ? { destinationPath: row.destination_path } : {}),
    summary: row.summary,
    changeSetStatus: row.change_set_status,
    operationStatus: row.operation_status,
    backupStatus: row.backup_status ?? 'not_created',
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

function returningRow(rows: readonly ChangeSetRow[]): ChangeSetRow | undefined {
  const first: unknown = rows[0];
  return Array.isArray(first) ? first[0] as ChangeSetRow | undefined : first as ChangeSetRow | undefined;
}

async function lockRun(queryRunner: QueryRunner, runId: string): Promise<void> {
  await queryRunner.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`change-set:${runId}`]);
}

async function assertPrincipalActive(queryRunner: QueryRunner, ownerId: string): Promise<void> {
  const rows: readonly { readonly id: string }[] = await queryRunner.query(
    'SELECT "id" FROM "users" WHERE "id" = $1 AND "is_active" = true AND ("expires_at" IS NULL OR "expires_at" > now()) FOR SHARE',
    [ownerId]
  );
  if (!rows[0]) throw new UnauthenticatedError();
}

async function assertProjectActive(queryRunner: QueryRunner, ownerId: string, projectId: string): Promise<void> {
  const project = await lockProjectWriteState(queryRunner, ownerId, projectId);
  if (!project || project.status === 'archived' || project.removalPending) {
    throw new ProjectArchivedError();
  }
}

async function assertPolicyAuthorizedRun(queryRunner: QueryRunner, input: PolicyAuthorizedChangeSetApplyClaim): Promise<void> {
  const rows: readonly {
    project_id: string;
    status: string;
    decision: string;
    policy_revision: string | null;
    provider_profile: string | null;
    model: string | null;
  }[] = await queryRunner.query(
    `SELECT "project_id", "status", "decision"::text AS "decision", "policy_revision",
       "manifest"->>'providerProfile' AS "provider_profile", "manifest"->>'model' AS "model"
     FROM "ai_runs" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1 FOR SHARE`,
    [input.ownerId, input.runId]
  );
  const run = rows[0];
  if (!run || run.project_id !== input.projectId || run.status !== 'running' || run.decision !== 'policy_authorized'
    || String(run.policy_revision) !== input.policyRevision || run.provider_profile !== input.providerProfile || run.model !== input.model) {
    throw new ChangeSetConflictError('This run is no longer authorized for workspace changes.');
  }
}

async function assertWorkspacePolicyCurrent(queryRunner: QueryRunner, input: PolicyAuthorizedChangeSetApplyClaim): Promise<void> {
  const rows: readonly {
    policy_profile: string;
    provider_profile: string | null;
    model: string | null;
    enabled: boolean;
    revoked_at: Date | string | null;
    revision: string;
  }[] = await queryRunner.query(
    `SELECT "policy_profile", "provider_profile", "model", "enabled", "revoked_at", "revision"
     FROM "assistant_scope_policies" WHERE "owner_id" = $1 AND "scope_kind" = 'project' AND "project_id" = $2
     LIMIT 1 FOR SHARE`,
    [input.ownerId, input.projectId]
  );
  const policy = rows[0];
  if (!policy || policy.policy_profile !== 'workspace_in_scope_v1' || !policy.enabled || policy.revoked_at !== null
    || String(policy.revision) !== input.policyRevision || policy.provider_profile !== input.providerProfile || policy.model !== input.model) {
    throw new ChangeSetConflictError('Workspace policy changed before the file changes were applied.');
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
