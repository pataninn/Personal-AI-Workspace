import type { DataSource, QueryRunner } from 'typeorm';

import { AppError } from '@/shared/errors/app-error';
import { SKILL_TOOL_CAPABILITIES, type SkillToolCapability } from '@/modules/skills/domain/skill-types';
import type { SkillContextRevision, SkillInvocation, SkillInvocationState } from '@/modules/skills/domain/skill-invocation-types';
import type { ClaimSkillInvocationRecord, ISkillInvocationRepository } from '@/modules/skills/repositories/skill-invocation-repository';

interface SkillInvocationRow {
  readonly id: string;
  readonly owner_id: string;
  readonly conversation_id: string;
  readonly skill_id: string;
  readonly skill_revision_id: string;
  readonly skill_version: number | string;
  readonly request_key_digest: string;
  readonly request_fingerprint: string;
  readonly context_revisions: unknown;
  readonly declared_tools: unknown;
  readonly title: string;
  readonly instructions: string;
  readonly enabled: boolean;
  readonly state: SkillInvocationState;
  readonly turn_id: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly current: boolean;
}

const INVOCATION_SELECT = `SELECT i."id", i."owner_id", i."conversation_id", i."skill_id", i."skill_revision_id", i."skill_version", i."request_key_digest", i."request_fingerprint", i."context_revisions", i."state", i."created_at", i."updated_at",
  r."declared_tools", r."title", r."instructions", r."enabled", h."id" AS "turn_id",
  (s."deleted_at" IS NULL AND s."current_version" = i."skill_version" AND r."enabled") AS "current"
  FROM "skill_invocations" i
  JOIN "skill_revisions" r ON r."owner_id" = i."owner_id" AND r."skill_id" = i."skill_id" AND r."id" = i."skill_revision_id" AND r."version" = i."skill_version"
  JOIN "skills" s ON s."owner_id" = i."owner_id" AND s."id" = i."skill_id"
  LEFT JOIN "home_turns" h ON h."owner_id" = i."owner_id" AND h."conversation_id" = i."conversation_id" AND h."skill_invocation_id" = i."id"`;

function asRows<T>(result: unknown): readonly T[] {
  if (!Array.isArray(result)) throw new Error('The skill invocation repository returned an unexpected query result.');
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as readonly T[];
  return result as readonly T[];
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('The skill invocation repository returned an invalid timestamp.');
  return date;
}

function toContextRevisions(value: unknown): readonly SkillContextRevision[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.length > 33) throw new Error('The skill invocation repository returned invalid context revisions.');
  const revisions: SkillContextRevision[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('The skill invocation repository returned invalid context revisions.');
    const record = item as Record<string, unknown>;
    if ((record.kind !== 'home_message' && record.kind !== 'project_fact') || typeof record.id !== 'string'
      || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1) {
      throw new Error('The skill invocation repository returned invalid context revisions.');
    }
    revisions.push({ kind: record.kind, id: record.id, revision: Number(record.revision) });
  }
  return revisions;
}

function toTools(value: unknown): readonly SkillToolCapability[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new Error('The skill invocation repository returned invalid tool capabilities.');
  const result: SkillToolCapability[] = [];
  for (const item of parsed) {
    const capability = typeof item === 'string' ? SKILL_TOOL_CAPABILITIES.find((candidate) => candidate === item) : undefined;
    if (!capability) throw new Error('The skill invocation repository returned invalid tool capabilities.');
    result.push(capability);
  }
  return result;
}

function toInvocation(row: SkillInvocationRow): SkillInvocation {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    skillId: row.skill_id,
    skillRevisionId: row.skill_revision_id,
    skillVersion: Number(row.skill_version),
    requestKeyDigest: row.request_key_digest,
    requestFingerprint: row.request_fingerprint,
    contextRevisions: toContextRevisions(row.context_revisions),
    declaredTools: toTools(row.declared_tools),
    title: row.title,
    instructions: row.instructions,
    enabled: row.enabled,
    state: row.state,
    turnId: row.turn_id,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    current: row.current
  };
}

export class TypeOrmSkillInvocationRepository implements ISkillInvocationRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async claim(input: ClaimSkillInvocationRecord): Promise<SkillInvocation> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `INSERT INTO "skill_invocations" ("owner_id", "conversation_id", "skill_id", "skill_revision_id", "skill_version", "request_key_digest", "request_fingerprint", "context_revisions")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT ("owner_id", "conversation_id", "request_key_digest") DO NOTHING`,
        [input.ownerId, input.conversationId, input.skillId, input.skillRevisionId, input.skillVersion, input.requestKeyDigest, input.requestFingerprint, JSON.stringify(input.contextRevisions)]
      );
      const rows: readonly SkillInvocationRow[] = await runner.query(
        `${INVOCATION_SELECT} WHERE i."owner_id" = $1 AND i."conversation_id" = $2 AND i."request_key_digest" = $3 LIMIT 1 FOR UPDATE OF i`,
        [input.ownerId, input.conversationId, input.requestKeyDigest]
      );
      const row = rows[0];
      if (!row) {
        const retained: readonly { readonly request_fingerprint: string }[] = asRows(await runner.query(
          `SELECT "request_fingerprint" FROM "skill_invocations"
           WHERE "owner_id" = $1 AND "conversation_id" = $2 AND "request_key_digest" = $3 LIMIT 1 FOR UPDATE`,
          [input.ownerId, input.conversationId, input.requestKeyDigest]
        ));
        if (retained[0]) {
          if (retained[0].request_fingerprint !== input.requestFingerprint) {
            throw new AppError('SKILL_IDEMPOTENCY_KEY_REUSED', 409, 'This Idempotency-Key was already used for a different invocation.');
          }
          throw new AppError('SKILL_NOT_FOUND', 404, 'The skill is unavailable.');
        }
        throw new Error('The skill invocation claim was not visible after insertion.');
      }
      if (row.request_fingerprint !== input.requestFingerprint) {
        throw new AppError('SKILL_IDEMPOTENCY_KEY_REUSED', 409, 'This Idempotency-Key was already used for a different invocation.');
      }
      await runner.commitTransaction();
      return toInvocation(row);
    } catch (error: unknown) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  public async findById(ownerId: string, invocationId: string): Promise<SkillInvocation | null> {
    const rows: readonly SkillInvocationRow[] = await this.dataSource.query(
      `${INVOCATION_SELECT} WHERE i."owner_id" = $1 AND i."id" = $2 LIMIT 1`,
      [ownerId, invocationId]
    );
    return rows[0] ? toInvocation(rows[0]) : null;
  }

  public async findByRequestKey(ownerId: string, conversationId: string, requestKeyDigest: string): Promise<SkillInvocation | null> {
    const rows: readonly SkillInvocationRow[] = await this.dataSource.query(
      `${INVOCATION_SELECT} WHERE i."owner_id" = $1 AND i."conversation_id" = $2 AND i."request_key_digest" = $3 LIMIT 1`,
      [ownerId, conversationId, requestKeyDigest]
    );
    return rows[0] ? toInvocation(rows[0]) : null;
  }

  public async findForTurn(ownerId: string, conversationId: string, turnId: string): Promise<SkillInvocation | null> {
    const rows: readonly SkillInvocationRow[] = await this.dataSource.query(
      `${INVOCATION_SELECT} WHERE h."owner_id" = $1 AND h."conversation_id" = $2 AND h."id" = $3 AND h."skill_invocation_id" IS NOT NULL LIMIT 1`,
      [ownerId, conversationId, turnId]
    );
    return rows[0] ? toInvocation(rows[0]) : null;
  }

  public async updateState(ownerId: string, invocationId: string, state: SkillInvocationState): Promise<SkillInvocation | null> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const rows = asRows<{ readonly state: SkillInvocationState }>(await runner.query(
        'SELECT "state" FROM "skill_invocations" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1 FOR UPDATE',
        [ownerId, invocationId]
      ));
      const current = rows[0]?.state;
      if (!current) {
        await runner.commitTransaction();
        return null;
      }
      if (canTransition(current, state)) {
        await runner.query('UPDATE "skill_invocations" SET "state" = $3, "updated_at" = now() WHERE "owner_id" = $1 AND "id" = $2', [ownerId, invocationId, state]);
      }
      await runner.commitTransaction();
      const updatedRows: readonly SkillInvocationRow[] = await this.dataSource.query(
        `${INVOCATION_SELECT} WHERE i."owner_id" = $1 AND i."id" = $2 LIMIT 1`,
        [ownerId, invocationId]
      );
      return updatedRows[0] ? toInvocation(updatedRows[0]) : null;
    } catch (error: unknown) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}

function canTransition(from: SkillInvocationState, to: SkillInvocationState): boolean {
  if (from === to) return true;
  switch (from) {
    case 'claimed': return to === 'bound' || to === 'denied';
    case 'bound': return to === 'dispatching' || to === 'denied';
    case 'dispatching': return to === 'accepted' || to === 'unknown' || to === 'denied';
    case 'accepted':
    case 'unknown':
    case 'denied': return false;
  }
}
