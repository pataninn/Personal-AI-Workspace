import type { DataSource, QueryRunner } from 'typeorm';
import { lockProjectWriteState } from '@/infrastructure/database/project-removal-write-barrier';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { resultContentScope, type StorageContentIdentity, type StorageContentMutationScope } from '@/infrastructure/database/storage-content-projections';
import type { StorageQuotaTransaction } from '@/modules/storage-quotas/repositories/storage-quota-repository';

import {
  AiRunAlreadyDecidedError,
  AiRunIdempotencyReusedError,
  AiRunManifestConflictError,
  AiRunNotFoundError,
  AiRunStateConflictError
} from '@/modules/ai-runs/domain/ai-run-errors';
import type { AiRun, CreateAiRunRecord, DecisionResult, DecisionUpdate, EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { AiRunActivityRecordPage, ListAiRunActivityInput } from '@/modules/ai-runs/domain/activity-types';
import type { CancelRunUpdate, CompleteRunUpdate, IAiRunRepository, RunMutationResult, StartRunUpdate } from '@/modules/ai-runs/repositories/ai-run-repository';
import { ProjectArchivedError } from '@/modules/conversations/domain/conversation-errors';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import type { TaskSuggestionCompletionWriter } from '@/infrastructure/database/repositories/task-suggestion-completion-writer';

interface AiRunRow {
  readonly id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly conversation_id: string;
  readonly request: string;
  readonly relative_root: string;
  readonly storage_kind: AiRun['storageKind'];
  readonly requested_paths: unknown;
  readonly manifest: unknown;
  readonly manifest_hash: string;
  readonly manifest_invalidated: boolean;
  readonly status: AiRun['status'];
  readonly phase: AiRun['phase'];
  readonly decision: AiRun['decision'];
  readonly cleanup: AiRun['cleanup'];
  readonly provider_transmission: AiRun['providerTransmission'];
  readonly staging_item_count: number;
  readonly runtime_kind: string | null;
  readonly sandbox_ready: boolean;
  readonly runtime_reference: string | null;
  readonly request_message_id: string | null;
  readonly assistant_message_id: string | null;
  readonly assistant_complete: boolean;
  readonly assistant_content_length: number | null;
  readonly provider_prompt_tokens?: number | string | null;
  readonly provider_completion_tokens?: number | string | null;
  readonly provider_total_tokens?: number | string | null;
  readonly start_idempotency_key: string | null;
  readonly start_fingerprint: string | null;
  readonly cancel_idempotency_key: string | null;
  readonly cancel_fingerprint: string | null;
  readonly create_idempotency_key: string;
  readonly request_fingerprint: string;
  readonly decision_idempotency_key: string | null;
  readonly decision_fingerprint: string | null;
  readonly provider_permission_id: string | null;
  readonly safe_message: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

export class TypeOrmAiRunRepository implements IAiRunRepository {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly taskSuggestionWriter?: TaskSuggestionCompletionWriter,
    private readonly storageAccounting = new TypeOrmStorageContentAccounting(dataSource)
  ) {}

  public async recoverInterruptedRunsForReview(): Promise<number> {
    const rows: unknown = await this.dataSource.query(
      `UPDATE "ai_runs"
       SET "status" = 'review_required', "phase" = 'review', "cleanup" = 'unknown',
           "provider_transmission" = CASE
             WHEN "provider_transmission" IN ('transmitted_confirmed', 'not_started_confirmed') THEN "provider_transmission"
             ELSE 'unknown'
           END,
           "safe_message" = $1, "updated_at" = now()
       WHERE "status" IN ('staging', 'ready', 'queued', 'running', 'waiting_approval', 'cancel_requested')
       RETURNING "id"`,
      ['The app restarted while this run was active. Review its saved status; no work was resumed automatically.']
    );
    return returnedCount(rows);
  }

  public async create(input: CreateAiRunRecord): Promise<{ readonly resource: AiRun; readonly replayed: boolean }> {
    return this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
      await assertPrincipalActive(queryRunner, input.ownerId);
      await lockIntent(queryRunner, `create:${input.ownerId}:${input.projectId}:${input.idempotencyKey}`);
      const existing = await this.findByIdempotency(queryRunner, input);
      if (existing) {
        if (existing.request_fingerprint !== input.requestFingerprint) {
          throw new AiRunIdempotencyReusedError();
        }
        const replay = await this.findById(queryRunner, existing.id);
        if (!replay) {
          throw new AiRunNotFoundError();
        }
        return { resource: replay, replayed: true };
      }
      await assertProjectActive(queryRunner, input.ownerId, input.projectId);
      const rows: readonly AiRunRow[] = await queryRunner.query(
       `INSERT INTO "ai_runs" ("owner_id", "project_id", "conversation_id", "request", "relative_root", "storage_kind", "requested_paths", "manifest", "manifest_hash", "create_idempotency_key", "request_fingerprint", "safe_message")
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
         RETURNING *`,
        [input.ownerId, input.projectId, input.conversationId, input.request, input.relativeRoot, input.storageKind, JSON.stringify(input.requestedPaths), JSON.stringify(input.manifest), input.manifest.manifestHash, input.idempotencyKey, input.requestFingerprint, 'Review the provider disclosure before continuing.']
      );
      const row = rows[0];
      if (!row) {
        throw new AiRunNotFoundError();
      }
      return { resource: toAiRun(row), replayed: false };
    }, resultContentScope((result: { readonly resource: AiRun; readonly replayed: boolean }) => [{ entity: 'ai_runs', id: result.resource.id }]));
  }

  public async findByIdForOwner(ownerId: string, runId: string): Promise<AiRun | null> {
    const rows: readonly AiRunRow[] = await this.dataSource.query(
      'SELECT * FROM "ai_runs" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1',
      [ownerId, runId]
    );
    return rows[0] ? toAiRun(rows[0]) : null;
  }

  public async stopForInactivePrincipal(ownerId: string, runId: string): Promise<AiRun | null> {
    const rows: readonly AiRunRow[] = await this.dataSource.query(
      `UPDATE "ai_runs" SET "status" = 'cancel_requested', "phase" = 'terminal',
         "safe_message" = 'This run stopped because account access is no longer active.', "updated_at" = now()
       WHERE "owner_id" = $1 AND "id" = $2
         AND "status" IN ('pending_approval', 'staging', 'ready', 'queued', 'running', 'waiting_approval', 'cancel_requested')
       RETURNING *`,
      [ownerId, runId]
    );
    const row = returningRow(rows);
    return row ? toAiRun(row) : null;
  }

  public async listActivityForProjectOwner(input: ListAiRunActivityInput): Promise<AiRunActivityRecordPage> {
    const parameters: unknown[] = [input.ownerId, input.projectId];
    const filters: Record<ListAiRunActivityInput['filter'], string> = {
      all: '',
      active: ` AND r."status" IN ('pending_approval', 'staging', 'ready', 'queued', 'running', 'waiting_approval', 'cancel_requested')`,
      succeeded: ` AND r."status" = 'succeeded'`,
      attention: ` AND r."status" IN ('failed', 'blocked', 'review_required')`,
      cancelled: ` AND r."status" = 'cancelled'`,
      rejected: ` AND r."status" = 'rejected'`
    };
    let cursorFilter = '';
    if (input.cursor) {
      parameters.push(input.cursor.createdAt, input.cursor.id);
      cursorFilter = ` AND (r."created_at" < $3 OR (r."created_at" = $3 AND r."id" > $4))`;
    }
    parameters.push(input.limit + 1);
    const rows: readonly (AiRunRow & {
      readonly activity_change_status: string | null;
      readonly activity_change_operation_count: number | string | null;
      readonly activity_change_applied_count: number | string | null;
      readonly activity_change_skipped_count: number | string | null;
      readonly activity_change_failed_count: number | string | null;
      readonly activity_change_backup_count: number | string | null;
    })[] = await this.dataSource.query(
      `SELECT r.*, cs."status" AS "activity_change_status",
        jsonb_array_length(cs."operations") AS "activity_change_operation_count",
        COALESCE((cs."result"->>'appliedCount')::bigint, 0) AS "activity_change_applied_count",
        COALESCE((cs."result"->>'skippedCount')::bigint, 0) AS "activity_change_skipped_count",
        COALESCE((cs."result"->>'failedCount')::bigint, 0) AS "activity_change_failed_count",
        COALESCE((cs."result"->>'backupCount')::bigint, 0) AS "activity_change_backup_count"
       FROM "ai_runs" r
       LEFT JOIN "ai_run_change_sets" cs ON cs."owner_id" = r."owner_id" AND cs."project_id" = r."project_id" AND cs."run_id" = r."id"
       WHERE r."owner_id" = $1 AND r."project_id" = $2${filters[input.filter]}${cursorFilter}
       ORDER BY r."created_at" DESC, r."id" ASC LIMIT $${parameters.length}`,
      parameters
    );
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      records: page.map((row) => ({
        run: toAiRun(row),
        changeSet: row.activity_change_status ? {
          status: row.activity_change_status as NonNullable<AiRunActivityRecordPage['records'][number]['changeSet']>['status'],
          operationCount: safeCountOrZero(row.activity_change_operation_count),
          appliedCount: safeCountOrZero(row.activity_change_applied_count),
          skippedCount: safeCountOrZero(row.activity_change_skipped_count),
          failedCount: safeCountOrZero(row.activity_change_failed_count),
          backupCount: safeCountOrZero(row.activity_change_backup_count)
        } : null
      })),
      hasMore
    };
  }

  public async recordProviderUsage(ownerId: string, runId: string, usage: NonNullable<AiRun['providerUsage']>): Promise<AiRun | null> {
    const rows: readonly AiRunRow[] = await this.dataSource.query(
      `UPDATE "ai_runs" SET
        "provider_prompt_tokens" = COALESCE("provider_prompt_tokens", $1::bigint),
        "provider_completion_tokens" = COALESCE("provider_completion_tokens", $2::bigint),
        "provider_total_tokens" = COALESCE("provider_total_tokens", $3::bigint)
       WHERE "owner_id" = $4 AND "id" = $5 RETURNING *`,
      [usage.promptTokens ?? null, usage.completionTokens ?? null, usage.totalTokens ?? null, ownerId, runId]
    );
    const row = returningRow(rows);
    return row ? toAiRun(row) : null;
  }

  public async recordDecision(input: DecisionUpdate): Promise<DecisionResult> {
    const queryRunner = await this.startTransaction();
    try {
      await assertPrincipalActive(queryRunner, input.ownerId);
      await lockIntent(queryRunner, `decision:${input.runId}`);
      const projectId = await findProjectIdForRun(queryRunner, input.ownerId, input.runId);
      if (!projectId) throw new AiRunNotFoundError();
      await assertProjectActive(queryRunner, input.ownerId, projectId);
      const rows: readonly AiRunRow[] = await queryRunner.query('SELECT * FROM "ai_runs" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1 FOR UPDATE', [input.ownerId, input.runId]);
      const row = rows[0];
      if (!row) {
        throw new AiRunNotFoundError();
      }
      await assertPrincipalActive(queryRunner, input.ownerId);
      if (row.manifest_hash !== input.manifestHash) {
        throw new AiRunManifestConflictError();
      }
      if (row.decision_idempotency_key) {
        if (row.decision_idempotency_key !== input.idempotencyKey || row.decision_fingerprint !== input.requestFingerprint) {
          throw new AiRunAlreadyDecidedError();
        }
        await queryRunner.commitTransaction();
        return { resource: rowToAiRun(row), replayed: true };
      }
      if (row.decision !== 'pending') {
        throw new AiRunAlreadyDecidedError();
      }
      const status = input.decision === 'reject' ? 'rejected' : 'staging';
      const phase = input.decision === 'reject' ? 'decision' : 'staging';
      const decision = input.decision === 'reject' ? 'rejected' : 'approved';
      const safeMessage = input.decision === 'reject'
        ? 'This run was not started. No project content was staged or sent to NVIDIA.'
        : 'Preparing a private run environment.';
      const updatedRows: readonly AiRunRow[] = await queryRunner.query(
        `UPDATE "ai_runs" SET "status" = $1, "phase" = $2, "decision" = $3, "provider_permission_id" = $4, "decision_idempotency_key" = $5, "decision_fingerprint" = $6, "safe_message" = $7, "updated_at" = now()
         WHERE "id" = $8 RETURNING *`,
        [status, phase, decision, input.decision === 'approve' ? input.providerPermissionId ?? null : null, input.idempotencyKey, input.requestFingerprint, safeMessage, input.runId]
      );
      const updated = returningRow(updatedRows);
      if (!updated) {
        throw new AiRunNotFoundError();
      }
      await queryRunner.commitTransaction();
      return { resource: toAiRun(updated), replayed: false };
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async save(run: AiRun): Promise<void> {
    await this.dataSource.query(
      `UPDATE "ai_runs" SET "status" = $1, "phase" = $2, "decision" = $3, "provider_permission_id" = $4, "manifest_invalidated" = $5, "cleanup" = $6, "provider_transmission" = $7, "staging_item_count" = $8, "runtime_kind" = $9, "sandbox_ready" = $10, "runtime_reference" = $11, "request_message_id" = $12, "assistant_message_id" = $13, "assistant_complete" = $14, "assistant_content_length" = $15, "provider_prompt_tokens" = $16, "provider_completion_tokens" = $17, "provider_total_tokens" = $18, "start_idempotency_key" = $19, "start_fingerprint" = $20, "cancel_idempotency_key" = $21, "cancel_fingerprint" = $22, "safe_message" = $23, "updated_at" = now()
       WHERE "owner_id" = $24 AND "id" = $25`,
      [run.status, run.phase, run.decision, run.providerPermissionId ?? null, run.manifestInvalidated, run.cleanup, run.providerTransmission, run.stagingItemCount, run.runtimeKind ?? null, run.sandboxReady, run.runtimeReference ?? null, run.requestMessageId ?? null, run.assistantMessageId ?? null, run.assistantComplete ?? false, run.assistantContentLength ?? null, run.providerUsage?.promptTokens ?? null, run.providerUsage?.completionTokens ?? null, run.providerUsage?.totalTokens ?? null, run.startIdempotencyKey ?? null, run.startFingerprint ?? null, run.cancelIdempotencyKey ?? null, run.cancelFingerprint ?? null, run.safeMessage, run.ownerId, run.id]
    );
  }

  public async reopenProviderPermissionDecision(input: { readonly ownerId: string; readonly runId: string; readonly permissionId: string }): Promise<AiRun | null> {
    const rows: readonly AiRunRow[] = await this.dataSource.query(
      `UPDATE "ai_runs" SET "status" = 'pending_approval', "phase" = 'decision', "decision" = 'pending',
         "provider_permission_id" = NULL, "decision_idempotency_key" = NULL, "decision_fingerprint" = NULL,
         "start_idempotency_key" = NULL, "start_fingerprint" = NULL,
         "runtime_kind" = NULL, "sandbox_ready" = false, "runtime_reference" = NULL, "staging_item_count" = 0,
         "safe_message" = 'The saved provider permission was revoked. Review this context before continuing.', "updated_at" = now()
       WHERE "owner_id" = $1 AND "id" = $2 AND "provider_permission_id" = $3
         AND "status" IN ('ready', 'queued') AND "provider_transmission" = 'not_started_confirmed' RETURNING *`,
      [input.ownerId, input.runId, input.permissionId]
    );
    const row = returningRow(rows);
    return row ? toAiRun(row) : null;
  }

  public async beginStart(input: StartRunUpdate): Promise<RunMutationResult> {
    const queryRunner = await this.startTransaction();
    try {
      await assertPrincipalActive(queryRunner, input.ownerId);
      const projectId = await findProjectIdForRun(queryRunner, input.ownerId, input.runId);
      if (!projectId) throw new AiRunNotFoundError();
      await assertProjectActive(queryRunner, input.ownerId, projectId);
      const row = await this.findForUpdate(queryRunner, input.ownerId, input.runId);
      if (!row) {
        throw new AiRunNotFoundError();
      }
      await assertPrincipalActive(queryRunner, input.ownerId);
      if (row.start_idempotency_key) {
        if (row.start_idempotency_key !== input.idempotencyKey || row.start_fingerprint !== input.requestFingerprint) {
          throw new AiRunStateConflictError();
        }
        await queryRunner.commitTransaction();
        return { resource: toAiRun(row), replayed: true };
      }
      if (row.status !== 'ready') {
        throw new AiRunStateConflictError();
      }
      const rows: readonly AiRunRow[] = await queryRunner.query(
        `UPDATE "ai_runs" SET "status" = 'queued', "phase" = 'inference', "start_idempotency_key" = $1, "start_fingerprint" = $2, "safe_message" = $3, "updated_at" = now()
         WHERE "owner_id" = $4 AND "id" = $5 RETURNING *`,
        [input.idempotencyKey, input.requestFingerprint, 'Starting assistant run.', input.ownerId, input.runId]
      );
      const updated = returningRow(rows);
      if (!updated) {
        throw new AiRunNotFoundError();
      }
      await queryRunner.commitTransaction();
      return { resource: toAiRun(updated), replayed: false };
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async abortStart(input: StartRunUpdate): Promise<boolean> {
    const rows: readonly { readonly id: string }[] = await this.dataSource.query(`
      UPDATE "ai_runs" SET "status" = 'ready', "phase" = 'runtime',
        "start_idempotency_key" = NULL, "start_fingerprint" = NULL,
        "safe_message" = 'Private run environment ready.', "updated_at" = now()
      WHERE "owner_id" = $1 AND "id" = $2 AND "status" = 'queued'
        AND "start_idempotency_key" = $3 AND "start_fingerprint" = $4
        AND "provider_transmission" = 'not_started_confirmed'
      RETURNING "id"
    `, [input.ownerId, input.runId, input.idempotencyKey, input.requestFingerprint]);
    return rows.length > 0;
  }

  public async markRunning(ownerId: string, runId: string): Promise<AiRun | null> {
    const queryRunner = await this.startTransaction();
    try {
      const principalActiveBeforeRunLock = await isPrincipalActive(queryRunner, ownerId);
      if (principalActiveBeforeRunLock) {
        const projectId = await findProjectIdForRun(queryRunner, ownerId, runId);
        if (!projectId) {
          await queryRunner.commitTransaction();
          return null;
        }
        await assertProjectActive(queryRunner, ownerId, projectId);
      }
      const row = await this.findForUpdate(queryRunner, ownerId, runId);
      if (!row) {
        await queryRunner.commitTransaction();
        return null;
      }
      if (!principalActiveBeforeRunLock || !await isPrincipalActive(queryRunner, ownerId)) {
        const stopped = await stopInactiveRun(queryRunner, row);
        await queryRunner.commitTransaction();
        return stopped ? toAiRun(stopped) : toAiRun(row);
      }
      if (row.status !== 'queued' && row.status !== 'waiting_approval') {
        await queryRunner.commitTransaction();
        return toAiRun(row);
      }
      const rows: readonly AiRunRow[] = await queryRunner.query(
        `UPDATE "ai_runs" SET "status" = 'running', "phase" = 'inference', "safe_message" = $1, "updated_at" = now()
         WHERE "owner_id" = $2 AND "id" = $3 AND "status" IN ('queued', 'waiting_approval') RETURNING *`,
        ['Assistant is working.', ownerId, runId]
      );
      await queryRunner.commitTransaction();
      const updated = returningRow(rows);
      return updated ? toAiRun(updated) : toAiRun(row);
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async recordProviderTransmission(ownerId: string, runId: string, transmission: AiRun['providerTransmission']): Promise<AiRun | null> {
    const queryRunner = await this.startTransaction();
    try {
      const principalActiveBeforeRunLock = await isPrincipalActive(queryRunner, ownerId);
      const current = await this.findForUpdate(queryRunner, ownerId, runId);
      if (!current) {
        await queryRunner.commitTransaction();
        return null;
      }
      if (!principalActiveBeforeRunLock || !await isPrincipalActive(queryRunner, ownerId)) {
        const stopped = await stopInactiveRun(queryRunner, current);
        await queryRunner.commitTransaction();
        return stopped ? toAiRun(stopped) : toAiRun(current);
      }
      const rows: readonly AiRunRow[] = await queryRunner.query(
        `UPDATE "ai_runs" SET "provider_transmission" = $1::"ai_run_provider_transmission", "updated_at" = now()
         WHERE "owner_id" = $2 AND "id" = $3 AND "status" IN ('queued', 'running', 'waiting_approval')
           AND ("provider_transmission" <> 'transmitted_confirmed' OR $1 = 'transmitted_confirmed')
         RETURNING *`,
        [transmission, ownerId, runId]
      );
      await queryRunner.commitTransaction();
      const row = returningRow(rows);
      return row ? toAiRun(row) : null;
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async requestCancellation(input: CancelRunUpdate): Promise<RunMutationResult> {
    const queryRunner = await this.startTransaction();
    try {
      await assertPrincipalActive(queryRunner, input.ownerId);
      const projectId = await findProjectIdForRun(queryRunner, input.ownerId, input.runId);
      if (!projectId) throw new AiRunNotFoundError();
      await assertProjectActive(queryRunner, input.ownerId, projectId);
      const row = await this.findForUpdate(queryRunner, input.ownerId, input.runId);
      if (!row) {
        throw new AiRunNotFoundError();
      }
      await assertPrincipalActive(queryRunner, input.ownerId);
      if (row.cancel_idempotency_key) {
        if (row.cancel_idempotency_key !== input.idempotencyKey || row.cancel_fingerprint !== input.requestFingerprint) {
          throw new AiRunStateConflictError();
        }
        await queryRunner.commitTransaction();
        return { resource: toAiRun(row), replayed: true };
      }
      if (isTerminalStatus(row.status)) {
        await queryRunner.commitTransaction();
        return { resource: toAiRun(row), replayed: true };
      }
      if (!['ready', 'queued', 'running', 'waiting_approval'].includes(row.status)) {
        throw new AiRunStateConflictError();
      }
      const immediate = row.status === 'ready' || row.status === 'queued';
      const rows: readonly AiRunRow[] = await queryRunner.query(
        `UPDATE "ai_runs" SET "status" = $1, "phase" = 'terminal', "cleanup" = $2, "cancel_idempotency_key" = $3, "cancel_fingerprint" = $4, "safe_message" = $5, "updated_at" = now()
         WHERE "owner_id" = $6 AND "id" = $7 RETURNING *`,
        [immediate ? 'cancelled' : 'cancel_requested', immediate ? 'complete' : row.cleanup, input.idempotencyKey, input.requestFingerprint, immediate ? 'Run cancelled. No further assistant work will be applied.' : 'Stopping assistant run.', input.ownerId, input.runId]
      );
      const updated = returningRow(rows);
      if (!updated) {
        throw new AiRunNotFoundError();
      }
      await queryRunner.commitTransaction();
      return { resource: toAiRun(updated), replayed: false };
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async completeRun(input: CompleteRunUpdate): Promise<AiRun | null> {
    try {
      return await this.withAccountedTransaction(input.ownerId, async (queryRunner) => {
        const projectId = await findProjectIdForRun(queryRunner, input.ownerId, input.runId);
        if (!projectId) return null;
        await assertProjectActive(queryRunner, input.ownerId, projectId);
        const row = await this.findForUpdate(queryRunner, input.ownerId, input.runId);
        if (!row) return null;
        if (isTerminalStatus(row.status) || row.status === 'cancel_requested' || !['queued', 'running', 'waiting_approval'].includes(row.status)) {
          return toAiRun(row);
        }
        const principalActive = await isPrincipalActive(queryRunner, input.ownerId);
        if (!principalActive) return toAiRun(row);
        const assistantText = input.assistantText ?? '';
        let assistantId = row.assistant_message_id;
        if (input.assistantText !== undefined && assistantText.length > 0 && !assistantId) {
          const sequenceRows: readonly { sequence: number }[] = await queryRunner.query(
            'SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence" FROM "messages" WHERE "conversation_id" = $1',
            [row.conversation_id]
          );
          const sequence = Number(sequenceRows[0]?.sequence ?? 1);
          const messageRows: readonly { id: string }[] = await queryRunner.query(
            `INSERT INTO "messages" ("conversation_id", "role", "sequence", "content", "content_hash", "content_length")
             VALUES ($1, 'assistant', $2, $3, encode(digest($3, 'sha256'), 'hex'), $4) RETURNING "id"`,
            [row.conversation_id, sequence, assistantText, assistantText.length]
          );
          assistantId = messageRows[0]?.id ?? null;
          await queryRunner.query('UPDATE "conversations" SET "last_activity_at" = now(), "updated_at" = now() WHERE "id" = $1', [row.conversation_id]);
        }
        if (input.status === 'succeeded' && input.taskSuggestions && input.taskSuggestions.length > 0) {
          if (!this.taskSuggestionWriter) throw new Error('The task suggestion completion writer is unavailable.');
          await this.taskSuggestionWriter.persistForRunCompletion(queryRunner, {
            runId: row.id, ownerId: row.owner_id, projectId: row.project_id, conversationId: row.conversation_id
          }, input.taskSuggestions);
        }
        const rows: readonly AiRunRow[] = await queryRunner.query(
          `UPDATE "ai_runs" SET "status" = $1, "phase" = $2, "cleanup" = $3, "provider_transmission" = $4, "assistant_message_id" = $5, "assistant_complete" = $6, "assistant_content_length" = $7, "safe_message" = $8, "updated_at" = now()
           WHERE "owner_id" = $9 AND "id" = $10 AND "status" IN ('queued', 'running', 'waiting_approval') RETURNING *`,
          [input.status, input.status === 'review_required' ? 'review' : 'terminal', input.cleanup ?? (input.status === 'succeeded' ? 'complete' : row.cleanup), input.providerTransmission ?? row.provider_transmission, assistantId, input.assistantComplete ?? input.status === 'succeeded', input.assistantText === undefined ? row.assistant_content_length : assistantText.length, input.safeMessage, input.ownerId, input.runId]
        );
        const updated = returningRow(rows);
        return updated ? toAiRun(updated) : toAiRun(row);
      }, aiRunCompletionContentScope(input.ownerId, input.runId));
    } catch (error: unknown) {
      if (error instanceof UnauthenticatedError) return await this.stopForInactivePrincipal(input.ownerId, input.runId);
      throw error;
    }
  }

  public async markCancelled(ownerId: string, runId: string): Promise<AiRun | null> {
    const queryRunner = await this.startTransaction();
    try {
      const rows: readonly AiRunRow[] = await queryRunner.query(
        `UPDATE "ai_runs" SET "status" = 'cancelled', "phase" = 'terminal', "cleanup" = 'complete', "safe_message" = $1, "updated_at" = now()
         WHERE "owner_id" = $2 AND "id" = $3 AND "status" = 'cancel_requested' RETURNING *`,
        ['Run cancelled. No further assistant work will be applied.', ownerId, runId]
      );
      const updated = returningRow(rows);
      if (!updated) {
        const current = await this.findForUpdate(queryRunner, ownerId, runId);
        await queryRunner.commitTransaction();
        return current ? toAiRun(current) : null;
      }
      await queryRunner.commitTransaction();
      return toAiRun(updated);
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async markWaitingApproval(ownerId: string, runId: string, safeMessage: string): Promise<AiRun | null> {
    const queryRunner = await this.startTransaction();
    try {
      const principalActiveBeforeRunLock = await isPrincipalActive(queryRunner, ownerId);
      if (principalActiveBeforeRunLock) {
        const projectId = await findProjectIdForRun(queryRunner, ownerId, runId);
        if (!projectId) {
          await queryRunner.commitTransaction();
          return null;
        }
        await assertProjectActive(queryRunner, ownerId, projectId);
      }
      const current = await this.findForUpdate(queryRunner, ownerId, runId);
      if (!current) {
        await queryRunner.commitTransaction();
        return null;
      }
      if (!principalActiveBeforeRunLock || !await isPrincipalActive(queryRunner, ownerId)) {
        const stopped = await stopInactiveRun(queryRunner, current);
        await queryRunner.commitTransaction();
        return stopped ? toAiRun(stopped) : toAiRun(current);
      }
      const rows: readonly AiRunRow[] = await queryRunner.query(
        `UPDATE "ai_runs" SET "status" = 'waiting_approval', "phase" = 'inference', "safe_message" = $1, "updated_at" = now()
         WHERE "owner_id" = $2 AND "id" = $3 AND "status" IN ('queued', 'running') RETURNING *`,
        [safeMessage, ownerId, runId]
      );
      const updated = returningRow(rows);
      if (updated) {
        await queryRunner.commitTransaction();
        return toAiRun(updated);
      }
      const currentAfterUpdate = await this.findForUpdate(queryRunner, ownerId, runId);
      await queryRunner.commitTransaction();
      return currentAfterUpdate ? toAiRun(currentAfterUpdate) : null;
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async markReviewRequired(ownerId: string, runId: string, safeMessage: string): Promise<AiRun | null> {
    const queryRunner = await this.startTransaction();
    try {
      const rows: readonly AiRunRow[] = await queryRunner.query(
        `UPDATE "ai_runs" SET "status" = 'review_required', "phase" = 'review', "cleanup" = 'unknown', "provider_transmission" = CASE WHEN "provider_transmission" = 'transmitted_confirmed' THEN "provider_transmission" ELSE 'unknown' END, "safe_message" = $1, "updated_at" = now()
         WHERE "owner_id" = $2 AND "id" = $3 AND "status" IN ('queued', 'running', 'waiting_approval', 'cancel_requested') RETURNING *`,
        [safeMessage, ownerId, runId]
      );
      const updated = returningRow(rows);
      if (!updated) {
        const current = await this.findForUpdate(queryRunner, ownerId, runId);
        await queryRunner.commitTransaction();
        return current ? toAiRun(current) : null;
      }
      await queryRunner.commitTransaction();
      return toAiRun(updated);
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async withRunProjection(ownerId: string, runId: string, projection: (run: AiRun) => void): Promise<boolean> {
    const queryRunner = await this.startTransaction();
    try {
      const principalActiveBeforeRunLock = await isPrincipalActive(queryRunner, ownerId);
      if (principalActiveBeforeRunLock) {
        const projectId = await findProjectIdForRun(queryRunner, ownerId, runId);
        if (!projectId) {
          await queryRunner.commitTransaction();
          return false;
        }
        const project = await lockProjectWriteState(queryRunner, ownerId, projectId);
        if (!project || project.status !== 'active' || project.removalPending) {
          await queryRunner.commitTransaction();
          return false;
        }
      }
      const row = await this.findForUpdate(queryRunner, ownerId, runId);
      if (!row || isProjectionBlocked(row.status)) {
        await queryRunner.commitTransaction();
        return false;
      }
      if (!principalActiveBeforeRunLock || !await isPrincipalActive(queryRunner, ownerId)) {
        await stopInactiveRun(queryRunner, row);
        await queryRunner.commitTransaction();
        return false;
      }
      projection(toAiRun(row));
      await queryRunner.commitTransaction();
      return true;
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async startTransaction(): Promise<QueryRunner> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    return queryRunner;
  }

  private async withAccountedTransaction<T>(ownerId: string, action: (queryRunner: QueryRunner) => Promise<T>, scope: StorageContentMutationScope<T>): Promise<T> {
    const queryRunner = await this.startTransaction();
    try {
      const result = await this.storageAccounting.runMutation(queryRunner, ownerId, () => action(queryRunner), scope);
      await queryRunner.commitTransaction();
      return result;
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async findById(queryRunner: QueryRunner, id: string): Promise<AiRun | null> {
    const rows: readonly AiRunRow[] = await queryRunner.query('SELECT * FROM "ai_runs" WHERE "id" = $1 LIMIT 1', [id]);
    return rows[0] ? toAiRun(rows[0]) : null;
  }

  private async findForUpdate(queryRunner: QueryRunner, ownerId: string, runId: string): Promise<AiRunRow | null> {
    const rows: readonly AiRunRow[] = await queryRunner.query('SELECT * FROM "ai_runs" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1 FOR UPDATE', [ownerId, runId]);
    return rows[0] ?? null;
  }

  private async findByIdempotency(queryRunner: QueryRunner, input: CreateAiRunRecord): Promise<Pick<AiRunRow, 'id' | 'request_fingerprint'> | null> {
    const rows: readonly Pick<AiRunRow, 'id' | 'request_fingerprint'>[] = await queryRunner.query(
      'SELECT "id", "request_fingerprint" FROM "ai_runs" WHERE "owner_id" = $1 AND "project_id" = $2 AND "create_idempotency_key" = $3 LIMIT 1',
      [input.ownerId, input.projectId, input.idempotencyKey]
    );
    return rows[0] ?? null;
  }
}

function aiRunCompletionContentScope(ownerId: string, runId: string): StorageContentMutationScope<AiRun | null> {
  const identities = async (transaction: StorageQuotaTransaction): Promise<readonly StorageContentIdentity[]> => {
    const rows = await transaction.query(
      'SELECT "assistant_message_id" FROM "ai_runs" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1',
      [ownerId, runId]
    ) as readonly { assistant_message_id: string | null }[];
    const suggestions = await transaction.query(
      'SELECT "id" FROM "project_task_suggestions" WHERE "owner_id" = $1 AND "run_id" = $2',
      [ownerId, runId]
    ) as readonly { id: string }[];
    return [
      { entity: 'ai_runs', id: runId },
      ...(rows[0]?.assistant_message_id ? [{ entity: 'messages' as const, id: rows[0].assistant_message_id }] : []),
      ...suggestions.map((row) => ({ entity: 'project_task_suggestions' as const, id: row.id }))
    ];
  };
  return { before: identities, after: identities };
}

async function lockIntent(queryRunner: QueryRunner, key: string): Promise<void> {
  await queryRunner.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

async function isPrincipalActive(queryRunner: QueryRunner, ownerId: string): Promise<boolean> {
  const rows: readonly { id: string }[] = await queryRunner.query(
    'SELECT "id" FROM "users" WHERE "id" = $1 AND "is_active" = true AND ("expires_at" IS NULL OR "expires_at" > now()) FOR SHARE',
    [ownerId]
  );
  return rows.length > 0;
}

async function assertPrincipalActive(queryRunner: QueryRunner, ownerId: string): Promise<void> {
  if (!await isPrincipalActive(queryRunner, ownerId)) throw new UnauthenticatedError();
}

async function stopInactiveRun(queryRunner: QueryRunner, row: AiRunRow): Promise<AiRunRow | null> {
  const rows: readonly AiRunRow[] = await queryRunner.query(
    `UPDATE "ai_runs" SET "status" = 'cancel_requested', "phase" = 'terminal',
       "safe_message" = 'This run stopped because account access is no longer active.', "updated_at" = now()
     WHERE "owner_id" = $1 AND "id" = $2
       AND "status" IN ('pending_approval', 'staging', 'ready', 'queued', 'running', 'waiting_approval', 'cancel_requested')
     RETURNING *`,
    [row.owner_id, row.id]
  );
  return returningRow(rows) ?? row;
}

async function assertProjectActive(queryRunner: QueryRunner, ownerId: string, projectId: string): Promise<void> {
  const project = await lockProjectWriteState(queryRunner, ownerId, projectId);
  if (!project || project.status === 'archived' || project.removalPending) {
    throw new ProjectArchivedError();
  }
}

async function findProjectIdForRun(queryRunner: QueryRunner, ownerId: string, runId: string): Promise<string | null> {
  const rows: readonly { readonly project_id: string }[] = await queryRunner.query(
    'SELECT "project_id" FROM "ai_runs" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1',
    [ownerId, runId]
  );
  return rows[0]?.project_id ?? null;
}

function toAiRun(row: AiRunRow): AiRun {
  const manifest = parseManifest(row.manifest, row.manifest_hash);
  const providerUsage = readProviderUsage(row);
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    request: row.request,
    relativeRoot: row.relative_root,
    storageKind: row.storage_kind,
    requestedPaths: parsePaths(row.requested_paths),
    manifest,
    manifestInvalidated: row.manifest_invalidated,
    status: row.status,
    phase: row.phase,
    decision: row.decision,
    ...(row.provider_permission_id ? { providerPermissionId: row.provider_permission_id } : {}),
    cleanup: row.cleanup,
    providerTransmission: row.provider_transmission,
    stagingItemCount: row.staging_item_count,
    ...(row.runtime_kind === 'fake' ? { runtimeKind: 'fake' as const } : row.runtime_kind === 'direct' ? { runtimeKind: 'direct' as const } : row.runtime_kind === 'hermes' ? { runtimeKind: 'hermes' as const } : {}),
    sandboxReady: row.sandbox_ready,
    ...(row.runtime_reference ? { runtimeReference: row.runtime_reference } : {}),
    ...(row.request_message_id ? { requestMessageId: row.request_message_id } : {}),
    ...(row.assistant_message_id ? { assistantMessageId: row.assistant_message_id } : {}),
    ...(row.assistant_complete ? { assistantComplete: true } : {}),
    ...(typeof row.assistant_content_length === 'number' ? { assistantContentLength: row.assistant_content_length } : {}),
    ...(providerUsage ? { providerUsage } : {}),
    ...(row.start_idempotency_key ? { startIdempotencyKey: row.start_idempotency_key } : {}),
    ...(row.start_fingerprint ? { startFingerprint: row.start_fingerprint } : {}),
    ...(row.cancel_idempotency_key ? { cancelIdempotencyKey: row.cancel_idempotency_key } : {}),
    ...(row.cancel_fingerprint ? { cancelFingerprint: row.cancel_fingerprint } : {}),
    ...(row.decision_idempotency_key ? { decisionIdempotencyKey: row.decision_idempotency_key } : {}),
    ...(row.decision_fingerprint ? { decisionFingerprint: row.decision_fingerprint } : {}),
    safeMessage: row.safe_message,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

function readProviderUsage(row: AiRunRow): AiRun['providerUsage'] {
  const promptTokens = safeUsageCount(row.provider_prompt_tokens);
  const completionTokens = safeUsageCount(row.provider_completion_tokens);
  const totalTokens = safeUsageCount(row.provider_total_tokens);
  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return undefined;
  }
  return {
    ...(promptTokens !== null ? { promptTokens } : {}),
    ...(completionTokens !== null ? { completionTokens } : {}),
    ...(totalTokens !== null ? { totalTokens } : {})
  };
}

function safeCountOrZero(value: number | string | null | undefined): number {
  return safeUsageCount(value) ?? 0;
}

function safeUsageCount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

const rowToAiRun = toAiRun;

function returningRow(rows: readonly AiRunRow[]): AiRunRow | undefined {
  const first: unknown = rows[0];
  return Array.isArray(first) ? first[0] as AiRunRow | undefined : first as AiRunRow | undefined;
}

function returnedCount(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  const rows = Array.isArray(result[0]) ? result[0] : result;
  return rows.length;
}

function parseManifest(value: unknown, manifestHash: string): EgressManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The stored egress manifest is invalid.');
  }
  const candidate = value as Partial<EgressManifest>;
  return {
    manifestHash,
    provider: candidate.providerProfile === 'nebius-token-factory' ? 'Nebius Token Factory' : 'NVIDIA hosted NIM',
    providerProfile: typeof candidate.providerProfile === 'string' ? candidate.providerProfile : 'nvidia-hosted-nim',
    model: typeof candidate.model === 'string' ? candidate.model : 'nvidia/nemotron-3-super-120b-a12b',
    categories: Array.isArray(candidate.categories) ? candidate.categories.filter((item): item is string => typeof item === 'string') : [],
    files: Array.isArray(candidate.files) ? candidate.files.filter(isFileEntry) : [],
    requestBytes: numberValue(candidate.requestBytes),
    messageBytes: numberValue(candidate.messageBytes),
    messageCount: numberValue(candidate.messageCount),
    messageHash: typeof candidate.messageHash === 'string' ? candidate.messageHash : '',
    ...(Array.isArray(candidate.messages) ? { messages: candidate.messages.filter((message) => typeof message?.role === 'string' && typeof message?.content === 'string') } : {}),
    ...(Array.isArray(candidate.facts) ? { facts: candidate.facts } : {}),
    byteEstimate: numberValue(candidate.byteEstimate),
    tokenEstimate: numberValue(candidate.tokenEstimate),
    excludedItemCount: numberValue(candidate.excludedItemCount),
    omittedItemCount: numberValue(candidate.omittedItemCount),
    omissionSummary: typeof candidate.omissionSummary === 'string' ? candidate.omissionSummary : 'No selected items were excluded.',
    bestEffortSecretDetection: true
  };
}

function isFileEntry(value: unknown): value is EgressManifest['files'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.relativePath === 'string' && typeof candidate.sourceHash === 'string' && typeof candidate.sizeBytes === 'number';
}

function parsePaths(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function isTerminalStatus(status: string): boolean {
  return ['succeeded', 'failed', 'blocked', 'cancelled', 'review_required', 'rejected'].includes(status);
}

function isProjectionBlocked(status: AiRun['status']): boolean {
  return status === 'cancel_requested' || isTerminalStatus(status);
}
