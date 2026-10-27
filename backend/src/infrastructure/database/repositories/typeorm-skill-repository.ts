import type { DataSource, QueryRunner } from 'typeorm';

import { lockProjectWriteState } from '@/infrastructure/database/project-removal-write-barrier';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { resultContentScope, type StorageContentMutationScope } from '@/infrastructure/database/storage-content-projections';
import { AppError } from '@/shared/errors/app-error';
import { SKILL_TOOL_CAPABILITIES, type Skill, type SkillDraft, type SkillToolCapability } from '@/modules/skills/domain/skill-types';
import type {
  CreateSkillRecord,
  CreateSkillResult,
  DeleteSkillRecord,
  ISkillRepository,
  UpdateSkillRecord
} from '@/modules/skills/repositories/skill-repository';
import type { StorageQuotaTransaction } from '@/modules/storage-quotas/repositories/storage-quota-repository';

interface SkillRow {
  readonly id: string;
  readonly revision_id: string;
  readonly owner_id: string;
  readonly workspace_id: string | null;
  readonly title: string;
  readonly instructions: string;
  readonly declared_tools: unknown;
  readonly enabled: boolean;
  readonly version: number | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface InsertedSkillRow {
  readonly id: string;
  readonly owner_id: string;
  readonly workspace_id: string | null;
  readonly current_version: number | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function asRows<T>(result: unknown): readonly T[] {
  if (!Array.isArray(result)) throw new Error('The skill repository returned an unexpected query result.');
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as readonly T[];
  return result as readonly T[];
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('The skill repository returned an invalid timestamp.');
  return date;
}

function toTools(value: unknown): readonly SkillToolCapability[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) {
    throw new Error('The skill repository returned invalid tool capabilities.');
  }
  const tools: SkillToolCapability[] = [];
  for (const item of parsed) {
    const capability = typeof item === 'string'
      ? SKILL_TOOL_CAPABILITIES.find((candidate) => candidate === item)
      : undefined;
    if (!capability) throw new Error('The skill repository returned invalid tool capabilities.');
    tools.push(capability);
  }
  return tools;
}

function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    revisionId: row.revision_id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    title: row.title,
    instructions: row.instructions,
    declaredTools: toTools(row.declared_tools),
    enabled: row.enabled,
    version: Number(row.version),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

const SKILL_SELECT = `SELECT s."id", r."id" AS "revision_id", s."owner_id", s."workspace_id", r."title", r."instructions", r."declared_tools", r."enabled", r."version", s."created_at", s."updated_at"
  FROM "skills" s JOIN "skill_revisions" r ON r."owner_id" = s."owner_id" AND r."skill_id" = s."id" AND r."version" = s."current_version"`;

function skillRevisionHistoryScope<TResult>(
  ownerId: string,
  skillId: string
): StorageContentMutationScope<TResult> {
  const readRevisionIdentities = async (transaction: StorageQuotaTransaction) => {
    const rows = await transaction.query(
      `SELECT "id" FROM "skill_revisions" WHERE "owner_id" = $1 AND "skill_id" = $2 ORDER BY "version" ASC`,
      [ownerId, skillId]
    ) as readonly { readonly id: string }[];
    return rows.map(({ id }) => ({ entity: 'skill_revisions' as const, id }));
  };
  return {
    before: readRevisionIdentities,
    after: readRevisionIdentities
  };
}

export class TypeOrmSkillRepository implements ISkillRepository {
  private readonly storageAccounting: Pick<TypeOrmStorageContentAccounting, 'runMutation'>;

  public constructor(
    private readonly dataSource: DataSource,
    storageAccounting?: Pick<TypeOrmStorageContentAccounting, 'runMutation'>
  ) {
    this.storageAccounting = storageAccounting ?? new TypeOrmStorageContentAccounting(dataSource);
  }

  public async listActive(ownerId: string, workspaceId?: string): Promise<readonly Skill[]> {
    const rows: readonly SkillRow[] = await this.dataSource.query(
      `${SKILL_SELECT} WHERE s."owner_id" = $1 AND s."deleted_at" IS NULL${workspaceId === undefined ? '' : ' AND (s."workspace_id" IS NULL OR s."workspace_id" = $2)'} ORDER BY s."updated_at" DESC, s."id" ASC`,
      workspaceId === undefined ? [ownerId] : [ownerId, workspaceId]
    );
    return rows.map(toSkill);
  }

  public async findActiveById(ownerId: string, skillId: string): Promise<Skill | null> {
    const rows: readonly SkillRow[] = await this.dataSource.query(
      `${SKILL_SELECT} WHERE s."owner_id" = $1 AND s."id" = $2 AND s."deleted_at" IS NULL LIMIT 1`,
      [ownerId, skillId]
    );
    return rows[0] ? toSkill(rows[0]) : null;
  }

  public async findActiveEnabledForShowcase(ownerId: string, workspaceId: string, skillIds: readonly string[]): Promise<readonly Skill[]> {
    if (skillIds.length === 0) return [];
    const rows: readonly SkillRow[] = await this.dataSource.query(
      `${SKILL_SELECT} WHERE s."owner_id" = $1 AND s."deleted_at" IS NULL AND r."enabled" = true
        AND (s."workspace_id" IS NULL OR s."workspace_id" = $2) AND s."id" = ANY($3::uuid[])
       ORDER BY s."id" ASC`,
      [ownerId, workspaceId, skillIds]
    );
    return rows.map(toSkill);
  }

  public async create(input: CreateSkillRecord): Promise<CreateSkillResult> {
    return await this.withAccountedMutation(input.ownerId, async (queryRunner) => {
      const existingRows = asRows<{
        readonly id: string;
        readonly create_request_fingerprint: string | null;
        readonly deleted_at: Date | string | null;
      }>(await queryRunner.query(
        `SELECT "id", "create_request_fingerprint", "deleted_at" FROM "skills"
         WHERE "owner_id" = $1 AND "create_request_key_digest" = $2 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.idempotencyKeyDigest]
      ));
      const existing = existingRows[0];
      if (existing) {
        if (existing.create_request_fingerprint !== input.requestFingerprint) {
          throw new AppError('SKILL_IDEMPOTENCY_KEY_REUSED', 409, 'This Idempotency-Key was already used for a different skill request.');
        }
        if (existing.deleted_at !== null) throw new AppError('SKILL_NOT_FOUND', 404, 'The skill is unavailable.');
        return { skill: await this.getCurrent(queryRunner, input.ownerId, existing.id), replayed: true };
      }

      await this.assertWritableWorkspace(queryRunner, input.ownerId, input.workspaceId);
      const inserted = asRows<InsertedSkillRow>(await queryRunner.query(
        `INSERT INTO "skills" ("owner_id", "workspace_id", "create_request_key_digest", "create_request_fingerprint")
         VALUES ($1, $2, $3, $4)
         RETURNING "id", "owner_id", "workspace_id", "current_version", "created_at", "updated_at"`,
        [input.ownerId, input.workspaceId, input.idempotencyKeyDigest, input.requestFingerprint]
      ))[0];
      if (!inserted) throw new Error('The skill could not be created.');
      await this.insertRevision(queryRunner, input.ownerId, inserted.id, 1, input);
      return { skill: await this.getCurrent(queryRunner, input.ownerId, inserted.id), replayed: false };
    }, resultContentScope((result: CreateSkillResult) => [{ entity: 'skill_revisions', id: result.skill.revisionId }]));
  }

  public async update(input: UpdateSkillRecord): Promise<Skill | null> {
    return await this.withAccountedMutation(input.ownerId, async (queryRunner) => {
      const currentRows: readonly SkillRow[] = await queryRunner.query(
        `${SKILL_SELECT} WHERE s."owner_id" = $1 AND s."id" = $2 AND s."deleted_at" IS NULL LIMIT 1`,
        [input.ownerId, input.skillId]
      );
      const current = currentRows[0] ? toSkill(currentRows[0]) : null;
      if (!current) return null;

      for (const workspaceId of [...new Set([current.workspaceId, input.workspaceId].filter((id): id is string => id !== null))].sort()) {
        await this.assertWritableWorkspace(queryRunner, input.ownerId, workspaceId);
      }
      const lockedRows: readonly SkillRow[] = await queryRunner.query(
        `${SKILL_SELECT} WHERE s."owner_id" = $1 AND s."id" = $2 AND s."deleted_at" IS NULL LIMIT 1 FOR UPDATE OF s`,
        [input.ownerId, input.skillId]
      );
      const locked = lockedRows[0] ? toSkill(lockedRows[0]) : null;
      if (!locked || locked.version !== input.expectedVersion) return null;
      if (sameDraft(locked, input)) return locked;
      if (sameDraft(current, input)) return current;

      const updatedRows = asRows<InsertedSkillRow>(await queryRunner.query(
        `UPDATE "skills" SET "workspace_id" = $1, "current_version" = "current_version" + 1, "updated_at" = now()
         WHERE "owner_id" = $2 AND "id" = $3 AND "current_version" = $4 AND "deleted_at" IS NULL
         RETURNING "id", "owner_id", "workspace_id", "current_version", "created_at", "updated_at"`,
        [input.workspaceId, input.ownerId, input.skillId, input.expectedVersion]
      ));
      const updated = updatedRows[0];
      if (!updated) return null;
      await this.insertRevision(queryRunner, input.ownerId, input.skillId, Number(updated.current_version), input);
      return await this.getCurrent(queryRunner, input.ownerId, input.skillId);
    }, skillRevisionHistoryScope(input.ownerId, input.skillId));
  }

  public async softDelete(input: DeleteSkillRecord): Promise<Skill | null> {
    return await this.withAccountedMutation(input.ownerId, async (queryRunner) => {
      const currentRows: readonly SkillRow[] = await queryRunner.query(
        `${SKILL_SELECT} WHERE s."owner_id" = $1 AND s."id" = $2 AND s."deleted_at" IS NULL LIMIT 1`,
        [input.ownerId, input.skillId]
      );
      const current = currentRows[0] ? toSkill(currentRows[0]) : null;
      if (!current || current.version !== input.expectedVersion) return null;
      await this.assertWritableWorkspace(queryRunner, input.ownerId, current.workspaceId);
      const lockedRows: readonly SkillRow[] = await queryRunner.query(
        `${SKILL_SELECT} WHERE s."owner_id" = $1 AND s."id" = $2 AND s."deleted_at" IS NULL LIMIT 1 FOR UPDATE OF s`,
        [input.ownerId, input.skillId]
      );
      const locked = lockedRows[0] ? toSkill(lockedRows[0]) : null;
      if (!locked || locked.version !== input.expectedVersion) return null;
      const rows = asRows<{ readonly id: string }>(await queryRunner.query(
        `UPDATE "skills" SET "deleted_at" = now(), "updated_at" = now()
         WHERE "owner_id" = $1 AND "id" = $2 AND "current_version" = $3 AND "deleted_at" IS NULL
         RETURNING "id"`,
        [input.ownerId, input.skillId, input.expectedVersion]
      ));
      return rows[0] ? locked : null;
    }, skillRevisionHistoryScope(input.ownerId, input.skillId));
  }

  private async insertRevision(
    queryRunner: QueryRunner,
    ownerId: string,
    skillId: string,
    version: number,
    draft: Pick<SkillDraft, 'title' | 'instructions' | 'enabled' | 'declaredTools'>
  ): Promise<string> {
    const rows = asRows<{ readonly id: string }>(await queryRunner.query(
      `INSERT INTO "skill_revisions" ("owner_id", "skill_id", "version", "title", "instructions", "enabled", "declared_tools")
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING "id"`,
      [ownerId, skillId, version, draft.title, draft.instructions, draft.enabled, JSON.stringify(draft.declaredTools)]
    ));
    if (!rows[0]) throw new Error('The skill revision could not be created.');
    return rows[0].id;
  }

  private async getCurrent(queryRunner: QueryRunner, ownerId: string, skillId: string): Promise<Skill> {
    const rows = await queryRunner.query(`${SKILL_SELECT} WHERE s."owner_id" = $1 AND s."id" = $2 LIMIT 1`, [ownerId, skillId]) as readonly SkillRow[];
    if (!rows[0]) throw new Error('The skill revision was not visible after it was created.');
    return toSkill(rows[0]);
  }

  private async assertWritableWorkspace(queryRunner: QueryRunner, ownerId: string, workspaceId: string | null): Promise<void> {
    if (workspaceId === null) return;
    const workspace = await lockProjectWriteState(queryRunner, ownerId, workspaceId);
    if (!workspace || workspace.status !== 'active' || workspace.removalPending) {
      throw new AppError('SKILL_WORKSPACE_NOT_FOUND', 404, 'The selected workspace is unavailable.');
    }
  }

  private async withAccountedMutation<T>(
    ownerId: string,
    mutation: (queryRunner: QueryRunner) => Promise<T>,
    scope: import('@/infrastructure/database/storage-content-projections').StorageContentMutationScope<T>
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    try {
      await queryRunner.connect();
      connected = true;
      await queryRunner.startTransaction();
      const result = await this.storageAccounting.runMutation(queryRunner, ownerId, () => mutation(queryRunner), scope);
      await queryRunner.commitTransaction();
      return result;
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      if (connected) await queryRunner.release();
    }
  }
}

function sameDraft(current: Skill, next: SkillDraft): boolean {
  return current.workspaceId === next.workspaceId
    && current.title === next.title
    && current.instructions === next.instructions
    && current.enabled === next.enabled
    && current.declaredTools.length === next.declaredTools.length
    && current.declaredTools.every((tool, index) => tool === next.declaredTools[index]);
}
