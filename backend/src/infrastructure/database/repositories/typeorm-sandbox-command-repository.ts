import type { DataSource, QueryRunner } from 'typeorm';

import { AiRunIdempotencyReusedError } from '@/modules/ai-runs/domain/ai-run-errors';
import {
  SandboxCommandBlockedError,
  SandboxCommandDecisionConflictError,
  SandboxCommandNotFoundError,
  SandboxCommandProposalConflictError
} from '@/modules/ai-runs/domain/command-errors';
import type {
  CommandCancellationUpdate,
  CommandDecisionUpdate,
  CommandLimits,
  CommandResult,
  CommandResultUpdate,
  CreateSandboxCommandRecord,
  SandboxCommand
} from '@/modules/ai-runs/domain/command-types';
import { MAX_SANDBOX_COMMANDS_PER_LIST } from '@/modules/ai-runs/domain/command-types';
import { sanitizeCommandResult } from '@/modules/ai-runs/domain/command-result';
import type { CommandMutationResult, ISandboxCommandRepository } from '@/modules/ai-runs/repositories/sandbox-command-repository';

interface SandboxCommandRow {
  readonly id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly proposal_hash: string;
  readonly command: string;
  readonly args: unknown;
  readonly cwd: string;
  readonly summary: string;
  readonly classification: SandboxCommand['classification'];
  readonly blocked_reason: string | null;
  readonly decision: SandboxCommand['decision'];
  readonly status: SandboxCommand['status'];
  readonly limits: unknown;
  readonly result: unknown;
  readonly cancel_requested: boolean;
  readonly create_idempotency_key: string;
  readonly create_fingerprint: string;
  readonly decision_idempotency_key: string | null;
  readonly decision_fingerprint: string | null;
  readonly cancel_idempotency_key: string | null;
  readonly cancel_fingerprint: string | null;
  readonly safe_message: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

export class TypeOrmSandboxCommandRepository implements ISandboxCommandRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async createProposal(input: CreateSandboxCommandRecord): Promise<CommandMutationResult> {
    const runner = await this.startTransaction();
    try {
      await lock(runner, `command-create:${input.ownerId}:${input.runId}:${input.createIdempotencyKey}`);
      const existing = await this.findByCreateKey(runner, input);
      if (existing) {
        if (existing.create_fingerprint !== input.createFingerprint) {
          throw new AiRunIdempotencyReusedError();
        }
        const replay = await this.findById(runner, existing.id);
        if (!replay) {
          throw new SandboxCommandNotFoundError();
        }
        await runner.commitTransaction();
        return { resource: replay, replayed: true };
      }
      const rows: readonly SandboxCommandRow[] = await runner.query(
        `INSERT INTO "sandbox_commands" ("owner_id", "project_id", "run_id", "proposal_hash", "command", "args", "cwd", "summary", "classification", "blocked_reason", "decision", "status", "limits", "safe_message", "create_idempotency_key", "create_fingerprint")
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16) RETURNING *`,
        [input.ownerId, input.projectId, input.runId, input.proposalHash, input.command, JSON.stringify(input.args), input.cwd, input.summary, input.classification, input.blockedReason ?? null, input.classification === 'blocked' ? 'not_applicable' : 'pending', input.classification === 'blocked' ? 'blocked' : 'awaiting_approval', JSON.stringify(input.limits), input.classification === 'blocked' ? 'The sandbox policy blocked this command before approval.' : 'Review this command before it runs.', input.createIdempotencyKey, input.createFingerprint]
      );
      const row = rows[0];
      if (!row) {
        throw new SandboxCommandNotFoundError();
      }
      await runner.commitTransaction();
      return { resource: toCommand(row), replayed: false };
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  public async listForRun(ownerId: string, runId: string, limit = MAX_SANDBOX_COMMANDS_PER_LIST): Promise<readonly SandboxCommand[]> {
    const rows: readonly SandboxCommandRow[] = await this.dataSource.query(
      'SELECT * FROM "sandbox_commands" WHERE "owner_id" = $1 AND "run_id" = $2 ORDER BY "created_at" ASC, "id" ASC LIMIT $3',
      [ownerId, runId, Math.max(0, Math.min(Math.floor(limit), MAX_SANDBOX_COMMANDS_PER_LIST))]
    );
    return rows.map(toCommand);
  }

  public async findByIdForOwner(ownerId: string, runId: string, commandId: string): Promise<SandboxCommand | null> {
    const rows: readonly SandboxCommandRow[] = await this.dataSource.query(
      'SELECT * FROM "sandbox_commands" WHERE "owner_id" = $1 AND "run_id" = $2 AND "id" = $3 LIMIT 1',
      [ownerId, runId, commandId]
    );
    return rows[0] ? toCommand(rows[0]) : null;
  }

  public async recordDecision(input: CommandDecisionUpdate): Promise<CommandMutationResult> {
    const runner = await this.startTransaction();
    try {
      await lock(runner, stateLockKey(input.commandId));
      const command = await this.findForUpdate(runner, input.ownerId, input.runId, input.commandId);
      if (!command) {
        throw new SandboxCommandNotFoundError();
      }
      if (command.proposal_hash !== input.proposalHash) {
        throw new SandboxCommandProposalConflictError();
      }
      if (command.decision_idempotency_key) {
        if (command.decision_idempotency_key !== input.idempotencyKey || command.decision_fingerprint !== input.requestFingerprint) {
          throw new SandboxCommandDecisionConflictError();
        }
        await runner.commitTransaction();
        return { resource: toCommand(command), replayed: true };
      }
      if (command.status === 'blocked') {
        throw new SandboxCommandBlockedError();
      }
      if (command.decision !== 'pending') {
        throw new SandboxCommandDecisionConflictError();
      }
      const rejected = input.decision === 'reject';
      const rows: readonly SandboxCommandRow[] = await runner.query(
        `UPDATE "sandbox_commands" SET "decision" = $1, "status" = $2, "decision_idempotency_key" = $3, "decision_fingerprint" = $4, "safe_message" = $5, "updated_at" = now() WHERE "id" = $6 RETURNING *`,
        [rejected ? 'rejected' : 'approved', rejected ? 'rejected' : 'awaiting_approval', input.idempotencyKey, input.requestFingerprint, rejected ? 'This command was rejected and was not started.' : 'Approval recorded. Starting the private sandbox command.', input.commandId]
      );
      const updated = rows[0];
      if (!updated) {
        throw new SandboxCommandNotFoundError();
      }
      await runner.commitTransaction();
      return { resource: toCommand(updated), replayed: false };
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  public async recordCancellation(input: CommandCancellationUpdate): Promise<CommandMutationResult> {
    const runner = await this.startTransaction();
    try {
      await lock(runner, stateLockKey(input.commandId));
      const command = await this.findForUpdate(runner, input.ownerId, input.runId, input.commandId);
      if (!command) {
        throw new SandboxCommandNotFoundError();
      }
      if (command.cancel_idempotency_key) {
        if (command.cancel_idempotency_key !== input.idempotencyKey || command.cancel_fingerprint !== input.requestFingerprint) {
          throw new SandboxCommandDecisionConflictError();
        }
        await runner.commitTransaction();
        return { resource: toCommand(command), replayed: true };
      }
      if (isTerminal(command.status)) {
        await runner.commitTransaction();
        return { resource: toCommand(command), replayed: true };
      }
      const running = command.status === 'running' || command.status === 'cancel_requested';
      const rows: readonly SandboxCommandRow[] = await runner.query(
        `UPDATE "sandbox_commands" SET "status" = $1, "decision" = $2, "cancel_requested" = true, "cancel_idempotency_key" = $3, "cancel_fingerprint" = $4, "safe_message" = $5, "updated_at" = now() WHERE "id" = $6 RETURNING *`,
        [running ? 'cancel_requested' : 'cancelled', command.decision === 'pending' ? 'rejected' : command.decision, input.idempotencyKey, input.requestFingerprint, running ? 'Cancellation requested for the private sandbox command.' : 'This command was cancelled before it started.', input.commandId]
      );
      const updated = rows[0];
      if (!updated) {
        throw new SandboxCommandNotFoundError();
      }
      await runner.commitTransaction();
      return { resource: toCommand(updated), replayed: false };
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  public async markRunning(ownerId: string, runId: string, commandId: string): Promise<SandboxCommand | null> {
    const runner = await this.startTransaction();
    try {
      await lock(runner, stateLockKey(commandId));
      const rows: readonly SandboxCommandRow[] = await runner.query(
        `UPDATE "sandbox_commands" SET "status" = 'running', "safe_message" = $1, "updated_at" = now() WHERE "owner_id" = $2 AND "run_id" = $3 AND "id" = $4 AND "decision" = 'approved' AND "status" = 'awaiting_approval' AND "cancel_requested" = false RETURNING *`,
        ['Running the command in the private sandbox.', ownerId, runId, commandId]
      );
      if (rows[0]) {
        await runner.commitTransaction();
        return toCommand(rows[0]);
      }
      const current = await this.findForUpdate(runner, ownerId, runId, commandId);
      await runner.commitTransaction();
      return current ? toCommand(current) : null;
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  public async saveResult(input: CommandResultUpdate): Promise<SandboxCommand> {
    const runner = await this.startTransaction();
    try {
      await lock(runner, stateLockKey(input.commandId));
      const current = await this.findForUpdate(runner, input.ownerId, input.runId, input.commandId);
      if (!current) {
        throw new SandboxCommandNotFoundError();
      }
      if (current.status !== 'cancel_requested') {
        await runner.commitTransaction();
        return toCommand(current);
      }
      const rows: readonly SandboxCommandRow[] = await runner.query(
        `UPDATE "sandbox_commands" SET "status" = $1, "result" = $2::jsonb, "cancel_requested" = COALESCE($3, "cancel_requested"), "safe_message" = $4, "updated_at" = now()
         WHERE "owner_id" = $5 AND "run_id" = $6 AND "id" = $7 AND "status" = 'cancel_requested' RETURNING *`,
        [input.status, input.result ? JSON.stringify(sanitizeCommandResult(input.result, parseLimits(current.limits))) : null, input.cancelRequested ?? null, input.safeMessage, input.ownerId, input.runId, input.commandId]
      );
      await runner.commitTransaction();
      return toCommand(rows[0] ?? current);
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  public async saveIfAwaiting(input: CommandResultUpdate): Promise<SandboxCommand | null> {
    const runner = await this.startTransaction();
    try {
      await lock(runner, stateLockKey(input.commandId));
      const current = await this.findForUpdate(runner, input.ownerId, input.runId, input.commandId);
      if (!current || current.status !== 'awaiting_approval' || current.cancel_requested) {
        await runner.commitTransaction();
        return null;
      }
      const rows: readonly SandboxCommandRow[] = await runner.query(
        `UPDATE "sandbox_commands" SET "status" = $1, "result" = $2::jsonb, "safe_message" = $3, "updated_at" = now()
         WHERE "owner_id" = $4 AND "run_id" = $5 AND "id" = $6 AND "status" = 'awaiting_approval' AND "cancel_requested" = false RETURNING *`,
        [input.status, input.result ? JSON.stringify(sanitizeCommandResult(input.result, parseLimits(current.limits))) : null, input.safeMessage, input.ownerId, input.runId, input.commandId]
      );
      await runner.commitTransaction();
      return rows[0] ? toCommand(rows[0]) : null;
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  public async saveExecutionResult(input: CommandResultUpdate): Promise<SandboxCommand | null> {
    const runner = await this.startTransaction();
    try {
      await lock(runner, stateLockKey(input.commandId));
      const current = await this.findForUpdate(runner, input.ownerId, input.runId, input.commandId);
      if (!current || current.status !== 'running' || current.cancel_requested) {
        await runner.commitTransaction();
        return null;
      }
      const rows: readonly SandboxCommandRow[] = await runner.query(
        `UPDATE "sandbox_commands" SET "status" = $1, "result" = $2::jsonb, "safe_message" = $3, "updated_at" = now()
         WHERE "owner_id" = $4 AND "run_id" = $5 AND "id" = $6 AND "status" = 'running' AND "cancel_requested" = false RETURNING *`,
        [input.status, input.result ? JSON.stringify(sanitizeCommandResult(input.result, parseLimits(current.limits))) : null, input.safeMessage, input.ownerId, input.runId, input.commandId]
      );
      await runner.commitTransaction();
      return rows[0] ? toCommand(rows[0]) : null;
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async startTransaction(): Promise<QueryRunner> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    return runner;
  }

  private async findByCreateKey(runner: QueryRunner, input: CreateSandboxCommandRecord): Promise<Pick<SandboxCommandRow, 'id' | 'create_fingerprint'> | null> {
    const rows: readonly Pick<SandboxCommandRow, 'id' | 'create_fingerprint'>[] = await runner.query(
      'SELECT "id", "create_fingerprint" FROM "sandbox_commands" WHERE "owner_id" = $1 AND "run_id" = $2 AND "create_idempotency_key" = $3 LIMIT 1',
      [input.ownerId, input.runId, input.createIdempotencyKey]
    );
    return rows[0] ?? null;
  }

  private async findById(runner: QueryRunner, id: string): Promise<SandboxCommand | null> {
    const rows: readonly SandboxCommandRow[] = await runner.query('SELECT * FROM "sandbox_commands" WHERE "id" = $1 LIMIT 1', [id]);
    return rows[0] ? toCommand(rows[0]) : null;
  }

  private async findForUpdate(runner: QueryRunner, ownerId: string, runId: string, commandId: string): Promise<SandboxCommandRow | null> {
    const rows: readonly SandboxCommandRow[] = await runner.query('SELECT * FROM "sandbox_commands" WHERE "owner_id" = $1 AND "run_id" = $2 AND "id" = $3 LIMIT 1 FOR UPDATE', [ownerId, runId, commandId]);
    return rows[0] ?? null;
  }
}

async function lock(runner: QueryRunner, key: string): Promise<void> {
  await runner.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

function stateLockKey(commandId: string): string {
  return `command-state:${commandId}`;
}

function toCommand(row: SandboxCommandRow): SandboxCommand {
  const limits = parseLimits(row.limits);
  const result = parseResult(row.result, limits);
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    runId: row.run_id,
    proposalHash: row.proposal_hash,
    command: row.command,
    args: parseStrings(row.args),
    cwd: row.cwd,
    summary: row.summary,
    classification: row.classification,
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
    decision: row.decision,
    status: row.status,
    limits,
    ...(result ? { result } : {}),
    cancelRequested: row.cancel_requested,
    createIdempotencyKey: row.create_idempotency_key,
    createFingerprint: row.create_fingerprint,
    ...(row.decision_idempotency_key ? { decisionIdempotencyKey: row.decision_idempotency_key } : {}),
    ...(row.decision_fingerprint ? { decisionFingerprint: row.decision_fingerprint } : {}),
    ...(row.cancel_idempotency_key ? { cancelIdempotencyKey: row.cancel_idempotency_key } : {}),
    ...(row.cancel_fingerprint ? { cancelFingerprint: row.cancel_fingerprint } : {}),
    safeMessage: row.safe_message,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

function parseStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseLimits(value: unknown): CommandLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The stored command limits are invalid.');
  }
  const candidate = value as Record<string, unknown>;
  return {
    wallTimeMs: numberValue(candidate.wallTimeMs),
    idleTimeMs: numberValue(candidate.idleTimeMs),
    maxOutputBytes: numberValue(candidate.maxOutputBytes),
    maxProcesses: numberValue(candidate.maxProcesses),
    memoryBytes: numberValue(candidate.memoryBytes),
    cpuTimeMs: numberValue(candidate.cpuTimeMs),
    network: 'denied'
  };
}

function parseResult(value: unknown, limits: CommandLimits): CommandResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.termination !== 'string' || typeof candidate.durationMs !== 'number' || typeof candidate.outputBytes !== 'number' || typeof candidate.outputLineCount !== 'number' || typeof candidate.outputTruncated !== 'boolean' || typeof candidate.outputSha256 !== 'string') {
    return undefined;
  }
  return sanitizeCommandResult({
    exitCode: typeof candidate.exitCode === 'number' ? candidate.exitCode : null,
    termination: candidate.termination as CommandResult['termination'],
    durationMs: candidate.durationMs,
    outputBytes: candidate.outputBytes,
    outputLineCount: candidate.outputLineCount,
    outputTruncated: candidate.outputTruncated,
    outputSha256: candidate.outputSha256,
    ...(typeof candidate.outputPreview === 'string' ? { outputPreview: candidate.outputPreview.slice(0, 4 * 1024) } : {})
  }, limits);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function isTerminal(status: SandboxCommand['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'timed_out' || status === 'output_truncated' || status === 'rejected' || status === 'blocked' || status === 'cancelled' || status === 'review_required';
}
