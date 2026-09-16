import type { DataSource, QueryRunner } from 'typeorm';

import {
  AiRunAlreadyDecidedError,
  AiRunIdempotencyReusedError,
  AiRunManifestConflictError,
  AiRunNotFoundError
} from '@/modules/ai-runs/domain/ai-run-errors';
import type { AiRun, CreateAiRunRecord, DecisionResult, DecisionUpdate, EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';

interface AiRunRow {
  readonly id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly conversation_id: string;
  readonly request: string;
  readonly relative_root: string;
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
  readonly create_idempotency_key: string;
  readonly request_fingerprint: string;
  readonly decision_idempotency_key: string | null;
  readonly decision_fingerprint: string | null;
  readonly safe_message: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

export class TypeOrmAiRunRepository implements IAiRunRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async create(input: CreateAiRunRecord): Promise<{ readonly resource: AiRun; readonly replayed: boolean }> {
    const queryRunner = await this.startTransaction();
    try {
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
        await queryRunner.commitTransaction();
        return { resource: replay, replayed: true };
      }
      const rows: readonly AiRunRow[] = await queryRunner.query(
        `INSERT INTO "ai_runs" ("owner_id", "project_id", "conversation_id", "request", "relative_root", "requested_paths", "manifest", "manifest_hash", "create_idempotency_key", "request_fingerprint", "safe_message")
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
         RETURNING *`,
        [input.ownerId, input.projectId, input.conversationId, input.request, input.relativeRoot, JSON.stringify(input.requestedPaths), JSON.stringify(input.manifest), input.manifest.manifestHash, input.idempotencyKey, input.requestFingerprint, 'Review the provider disclosure before continuing.']
      );
      const row = rows[0];
      if (!row) {
        throw new AiRunNotFoundError();
      }
      await queryRunner.commitTransaction();
      return { resource: toAiRun(row), replayed: false };
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async findByIdForOwner(ownerId: string, runId: string): Promise<AiRun | null> {
    const rows: readonly AiRunRow[] = await this.dataSource.query(
      'SELECT * FROM "ai_runs" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1',
      [ownerId, runId]
    );
    return rows[0] ? toAiRun(rows[0]) : null;
  }

  public async recordDecision(input: DecisionUpdate): Promise<DecisionResult> {
    const queryRunner = await this.startTransaction();
    try {
      await lockIntent(queryRunner, `decision:${input.runId}`);
      const rows: readonly AiRunRow[] = await queryRunner.query('SELECT * FROM "ai_runs" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1 FOR UPDATE', [input.ownerId, input.runId]);
      const row = rows[0];
      if (!row) {
        throw new AiRunNotFoundError();
      }
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
        `UPDATE "ai_runs" SET "status" = $1, "phase" = $2, "decision" = $3, "decision_idempotency_key" = $4, "decision_fingerprint" = $5, "safe_message" = $6, "updated_at" = now()
         WHERE "id" = $7 RETURNING *`,
        [status, phase, decision, input.idempotencyKey, input.requestFingerprint, safeMessage, input.runId]
      );
      const updated = updatedRows[0];
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

  public async save(run: AiRun): Promise<void> {
    await this.dataSource.query(
      `UPDATE "ai_runs" SET "status" = $1, "phase" = $2, "decision" = $3, "manifest_invalidated" = $4, "cleanup" = $5, "provider_transmission" = $6, "staging_item_count" = $7, "runtime_kind" = $8, "sandbox_ready" = $9, "safe_message" = $10, "updated_at" = now()
       WHERE "owner_id" = $11 AND "id" = $12`,
      [run.status, run.phase, run.decision, run.manifestInvalidated, run.cleanup, run.providerTransmission, run.stagingItemCount, run.runtimeKind ?? null, run.sandboxReady, run.safeMessage, run.ownerId, run.id]
    );
  }

  private async startTransaction(): Promise<QueryRunner> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    return queryRunner;
  }

  private async findById(queryRunner: QueryRunner, id: string): Promise<AiRun | null> {
    const rows: readonly AiRunRow[] = await queryRunner.query('SELECT * FROM "ai_runs" WHERE "id" = $1 LIMIT 1', [id]);
    return rows[0] ? toAiRun(rows[0]) : null;
  }

  private async findByIdempotency(queryRunner: QueryRunner, input: CreateAiRunRecord): Promise<Pick<AiRunRow, 'id' | 'request_fingerprint'> | null> {
    const rows: readonly Pick<AiRunRow, 'id' | 'request_fingerprint'>[] = await queryRunner.query(
      'SELECT "id", "request_fingerprint" FROM "ai_runs" WHERE "owner_id" = $1 AND "project_id" = $2 AND "create_idempotency_key" = $3 LIMIT 1',
      [input.ownerId, input.projectId, input.idempotencyKey]
    );
    return rows[0] ?? null;
  }
}

async function lockIntent(queryRunner: QueryRunner, key: string): Promise<void> {
  await queryRunner.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

function toAiRun(row: AiRunRow): AiRun {
  const manifest = parseManifest(row.manifest, row.manifest_hash);
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    request: row.request,
    relativeRoot: row.relative_root,
    requestedPaths: parsePaths(row.requested_paths),
    manifest,
    manifestInvalidated: row.manifest_invalidated,
    status: row.status,
    phase: row.phase,
    decision: row.decision,
    cleanup: row.cleanup,
    providerTransmission: row.provider_transmission,
    stagingItemCount: row.staging_item_count,
    ...(row.runtime_kind === 'fake' ? { runtimeKind: 'fake' } : {}),
    sandboxReady: row.sandbox_ready,
    ...(row.decision_idempotency_key ? { decisionIdempotencyKey: row.decision_idempotency_key } : {}),
    ...(row.decision_fingerprint ? { decisionFingerprint: row.decision_fingerprint } : {}),
    safeMessage: row.safe_message,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

const rowToAiRun = toAiRun;

function parseManifest(value: unknown, manifestHash: string): EgressManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The stored egress manifest is invalid.');
  }
  const candidate = value as Partial<EgressManifest>;
  return {
    manifestHash,
    provider: 'NVIDIA hosted NIM',
    providerProfile: typeof candidate.providerProfile === 'string' ? candidate.providerProfile : 'nvidia-hosted-nim',
    model: typeof candidate.model === 'string' ? candidate.model : 'nvidia/nemotron-3-super-120b-a12b',
    categories: Array.isArray(candidate.categories) ? candidate.categories.filter((item): item is string => typeof item === 'string') : [],
    files: Array.isArray(candidate.files) ? candidate.files.filter(isFileEntry) : [],
    requestBytes: numberValue(candidate.requestBytes),
    messageBytes: numberValue(candidate.messageBytes),
    messageCount: numberValue(candidate.messageCount),
    messageHash: typeof candidate.messageHash === 'string' ? candidate.messageHash : '',
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
