import type { DataSource, QueryRunner } from 'typeorm';
import { lockProjectWriteState } from '@/infrastructure/database/project-removal-write-barrier';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { fixedContentScope } from '@/infrastructure/database/storage-content-projections';

import type { ActionLedgerMutationResult, ActionLedgerRecord, ActionLedgerReversibleFieldName } from '@/modules/action-ledger/domain/action-ledger-types';
import { ActionLedgerTargetStateConflictError } from '@/modules/action-ledger/domain/action-ledger-errors';
import { ProjectArchivedError, ProjectNameConflictError, ProjectRootOverlapError } from '@/modules/projects/domain/project-errors';
import { projectRootOverlapKey, projectRootsOverlap } from '@/modules/projects/domain/project-root-policy';
import type { Project, ProjectStatus } from '@/modules/projects/domain/project-types';
import type {
  CreateProjectRecord,
  IProjectRepository,
  UpdateProjectStatusRecord
} from '@/modules/projects/repositories/project-repository';
import type {
  CreatePlanningProjectRecord,
  IProjectWorkspaceRepository,
  ProjectMetadataSearchResult,
  UpdateProjectObjectiveRecord,
  AttachProjectRootRecord,
  IWorkspaceUndoParticipant
} from '@/modules/projects/repositories/project-workspace-repository';

interface ProjectRow {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly slug: string;
  readonly relative_root: string | null;
  readonly relative_root_key: string | null;
  readonly storage_kind: Project['storageKind'];
  readonly objective: string | null;
  readonly status: ProjectStatus;
  readonly version: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    slug: row.slug,
    relativeRoot: row.relative_root,
    storageKind: row.storage_kind,
    objective: row.objective,
    status: row.status,
    version: row.version,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function asRows<T>(result: unknown): readonly T[] {
  if (!Array.isArray(result)) throw new Error('The project repository returned an unexpected query result.');
  // TypeORM returns [rows, rowCount] for UPDATE ... RETURNING via QueryRunner.
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as readonly T[];
  return result as readonly T[];
}

function workspaceUndoResult(projectId: string, preVersion: number, postVersion: number): ActionLedgerMutationResult {
  return {
    preVersion,
    postVersion,
    reversibleFields: {},
    outcome: { targetId: projectId, targetVersion: postVersion },
    undoStatus: 'not_reversible'
  };
}

interface CompletedChildReceiptRow {
  readonly id: string | null;
  readonly action_kind: string | null;
  readonly target_kind: string | null;
  readonly target_id: string | null;
  readonly undo_status: string | null;
  readonly undo_action_id: string | null;
  readonly creation_order_version: string | number | null;
  readonly compensation_id: string | null;
  readonly compensation_kind: string | null;
  readonly compensation_undo_status: string | null;
  readonly compensation_undo_of: string | null;
  readonly compensation_target_kind: string | null;
  readonly compensation_target_id: string | null;
  readonly compensation_target_version: string | number | null;
  readonly compensation_post_version: string | number | null;
  readonly task_owner_id: string | null;
  readonly task_project_id: string | null;
  readonly task_status: string | null;
  readonly task_version: string | number | null;
  readonly task_position: string | number | null;
  readonly created_event_count: string | number;
  readonly created_position: string | null;
  readonly archive_event_count: string | number;
  readonly other_event_count: string | number;
}

interface WorkspaceEmptyRow {
  readonly has_content: boolean;
}

async function lockOwner(queryRunner: QueryRunner, ownerId: string): Promise<void> {
  await queryRunner.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`projects:${ownerId}`]);
}

async function findReservedRoots(queryRunner: QueryRunner, ownerId: string): Promise<readonly { readonly relative_root: string; readonly storage_kind: Project['storageKind'] }[]> {
  const rows: readonly { relative_root: string; storage_kind: Project['storageKind'] }[] = await queryRunner.query(
    'SELECT "root_key" AS "relative_root", "storage_kind" FROM "storage_root_mappings" WHERE "owner_id" = $1 ORDER BY "root_key" FOR UPDATE',
    [ownerId]
  );
  return rows;
}

export class TypeOrmProjectRepository implements IProjectRepository, IProjectWorkspaceRepository<QueryRunner>, IWorkspaceUndoParticipant<QueryRunner> {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly storageAccounting = new TypeOrmStorageContentAccounting(dataSource)
  ) {}

  public async listByOwner(ownerId: string, includeArchived: boolean): Promise<readonly Project[]> {
    const statusFilter = includeArchived ? '' : ' AND "status" = \'active\'';
    const rows: readonly ProjectRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective", "status", "version", "created_at", "updated_at"
       FROM "projects" WHERE "owner_id" = $1${statusFilter} ORDER BY CASE WHEN "status" = 'active' THEN 0 ELSE 1 END, "name" ASC, "created_at" ASC`,
      [ownerId]
    );
    return rows.map(toProject);
  }

  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> {
    const rows: readonly ProjectRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective", "status", "version", "created_at", "updated_at"
       FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1`,
      [ownerId, projectId]
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  public async listActiveRoots(ownerId: string, storageKind?: Project['storageKind']): Promise<readonly string[]> {
    const kindFilter = storageKind === undefined ? '' : ' AND "storage_kind" IS NOT DISTINCT FROM $2';
    const parameters = storageKind === undefined ? [ownerId] : [ownerId, storageKind];
    const rows: readonly { relative_root: string }[] = await this.dataSource.query(
      `SELECT "relative_root_key" AS "relative_root" FROM "projects" WHERE "owner_id" = $1 AND "status" = 'active' AND "relative_root_key" IS NOT NULL${kindFilter}`,
      parameters
    );
    return rows.map((row) => row.relative_root);
  }

  public async searchForOwner(ownerId: string, query: string, limit: number): Promise<ProjectMetadataSearchResult> {
    const rows: readonly ProjectRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective", "status", "version", "created_at", "updated_at"
       FROM "projects"
       WHERE "owner_id" = $1 AND "status" = 'active'
         AND (strpos(lower("name"), lower($2)) > 0 OR strpos(lower(coalesce("objective", '')), lower($2)) > 0)
       ORDER BY "updated_at" DESC, "name" ASC, "id" ASC LIMIT $3`,
      [ownerId, query, limit + 1]
    );
    return { projects: rows.slice(0, limit).map(toProject), hasMore: rows.length > limit };
  }

  public async lockOwnerRoots(transaction: QueryRunner, ownerId: string): Promise<void> {
    await lockOwner(transaction, ownerId);
  }

  public async findByIdForOwnerForUpdate(transaction: QueryRunner, ownerId: string, projectId: string): Promise<Project | null> {
    const rows: readonly ProjectRow[] = await transaction.query(
      `SELECT "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective", "status", "version", "created_at", "updated_at"
       FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1 FOR UPDATE`,
      [ownerId, projectId]
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  public async listActiveRootKeys(transaction: QueryRunner, ownerId: string, exceptProjectId?: string): Promise<readonly string[]> {
    const exclude = exceptProjectId === undefined ? '' : ' AND "id" <> $2';
    const parameters = exceptProjectId === undefined ? [ownerId] : [ownerId, exceptProjectId];
    const rows: readonly { relative_root: string }[] = await transaction.query(
      `SELECT "relative_root_key" AS "relative_root" FROM "projects"
       WHERE "owner_id" = $1 AND "status" = 'active' AND "relative_root_key" IS NOT NULL${exclude}`,
      parameters
    );
    return rows.map((row) => row.relative_root);
  }

  public async createPlanning(transaction: QueryRunner, input: CreatePlanningProjectRecord): Promise<Project> {
    try {
      const rows: readonly ProjectRow[] = await transaction.query(
        `INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective")
         VALUES ($1, $2, $3, $4, NULL, NULL, NULL, $5)
         RETURNING "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective", "status", "version", "created_at", "updated_at"`,
        [input.id, input.ownerId, input.name, input.slug, input.objective]
      );
      const row = rows[0];
      if (!row) throw new Error('The planning project was not returned after insert.');
      return toProject(row);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new ProjectNameConflictError();
      throw error;
    }
  }

  public async updateObjective(transaction: QueryRunner, input: UpdateProjectObjectiveRecord): Promise<Project | null> {
    const project = await lockProjectWriteState(transaction, input.ownerId, input.projectId);
    if (!project) return null;
    if (project.removalPending) throw new ProjectArchivedError();
    const [rows]: readonly [readonly ProjectRow[], number] = await transaction.query(
      `UPDATE "projects" SET "objective" = $1, "version" = "version" + 1, "updated_at" = now()
       WHERE "owner_id" = $2 AND "id" = $3 AND "version" = $4
       RETURNING "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective", "status", "version", "created_at", "updated_at"`,
      [input.objective, input.ownerId, input.projectId, input.expectedVersion]
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  public async attachInitialRoot(transaction: QueryRunner, input: AttachProjectRootRecord): Promise<Project | null> {
    try {
      const project = await lockProjectWriteState(transaction, input.ownerId, input.projectId);
      if (!project) return null;
      if (project.removalPending) throw new ProjectArchivedError();
      const [rows]: readonly [readonly ProjectRow[], number] = await transaction.query(
        `UPDATE "projects" SET "relative_root" = $1, "relative_root_key" = $2, "storage_kind" = $3, "version" = "version" + 1, "updated_at" = now()
         WHERE "owner_id" = $4 AND "id" = $5 AND "version" = $6 AND "relative_root" IS NULL
         RETURNING "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective", "status", "version", "created_at", "updated_at"`,
        [input.relativeRoot, input.relativeRootKey, input.storageKind, input.ownerId, input.projectId, input.expectedVersion]
      );
      const row = rows[0];
      if (!row) return null;
      await transaction.query(
        `INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
         VALUES ($1, $2, $2, $3, $4, $5, 'active')`,
        [input.ownerId, input.projectId, input.relativeRootKey, input.storageKind, input.relativeRoot]
      );
      return toProject(row);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new ProjectRootOverlapError();
      throw error;
    }
  }

  /** Reverses one supported workspace receipt without touching filesystem state. */
  public async undoWorkspaceInTransaction(
    transaction: QueryRunner,
    input: {
      readonly ownerId: string;
      readonly original: ActionLedgerRecord;
      readonly completedTaskCreateActionIds: readonly string[];
    }
  ): Promise<ActionLedgerMutationResult> {
    const { ownerId, original, completedTaskCreateActionIds } = input;
    if (original.targetKind !== 'workspace' || original.undoStatus !== 'available') throw new ActionLedgerTargetStateConflictError('not_reversible');
    if (original.postVersion === null || original.outcome.targetVersion !== original.postVersion || original.outcome.targetId !== original.targetId) {
      throw new ActionLedgerTargetStateConflictError('changed');
    }

    await lockOwner(transaction, ownerId);
    const current = await this.findByIdForOwnerForUpdate(transaction, ownerId, original.targetId);
    if (!current) throw new ActionLedgerTargetStateConflictError('target_missing');
    const removalState = await lockProjectWriteState(transaction, ownerId, current.id);
    if (removalState?.removalPending) throw new ActionLedgerTargetStateConflictError('archived_workspace');
    if (current.status !== 'active') throw new ActionLedgerTargetStateConflictError('archived_workspace');
    if (current.version !== original.postVersion) throw new ActionLedgerTargetStateConflictError('changed');

    if (original.actionKind === 'workspace.update') {
      if (completedTaskCreateActionIds.length > 0 || Object.keys(original.reversibleFields).length === 0) {
        throw new ActionLedgerTargetStateConflictError('not_reversible');
      }
      const assignments: string[] = [];
      const values: unknown[] = [];
      for (const [field, pair] of Object.entries(original.reversibleFields)) {
        if (!pair || !('before' in pair) || !('after' in pair) || !['name', 'objective'].includes(field)) {
          throw new ActionLedgerTargetStateConflictError('unsupported_action');
        }
        const fieldName = field as Extract<ActionLedgerReversibleFieldName, 'name' | 'objective'>;
        const currentValue = fieldName === 'name' ? current.name : current.objective;
        if (currentValue !== pair.after || (pair.before !== null && typeof pair.before !== 'string')) {
          throw new ActionLedgerTargetStateConflictError('changed');
        }
        values.push(pair.before);
        assignments.push(`"${fieldName}" = $${values.length}`);
      }
      values.push(ownerId, current.id, original.postVersion);
      const updatedRows = asRows<ProjectRow>(await transaction.query(
        `UPDATE "projects" SET ${assignments.join(', ')}, "version" = "version" + 1, "updated_at" = now()
         WHERE "owner_id" = $${values.length - 2} AND "id" = $${values.length - 1} AND "version" = $${values.length} AND "status" = 'active'
         RETURNING "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective", "status", "version", "created_at", "updated_at"`,
        values
      ));
      const updated = updatedRows[0];
      if (!updated) throw new ActionLedgerTargetStateConflictError('changed');
      return workspaceUndoResult(current.id, current.version, updated.version);
    }

    if (original.actionKind !== 'workspace.create') throw new ActionLedgerTargetStateConflictError('unsupported_action');
    if (Object.keys(original.reversibleFields).length > 0) throw new ActionLedgerTargetStateConflictError('unsupported_action');
    if (current.relativeRoot !== null) throw new ActionLedgerTargetStateConflictError('folder_attached');
    await this.assertWorkspaceEmptyExceptUndoneChildren(transaction, ownerId, current.id, completedTaskCreateActionIds);
    const archivedRows = asRows<ProjectRow>(await transaction.query(
      `UPDATE "projects" SET "status" = 'archived', "version" = "version" + 1, "updated_at" = now()
       WHERE "owner_id" = $1 AND "id" = $2 AND "status" = 'active' AND "version" = $3 AND "relative_root" IS NULL
       RETURNING "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective", "status", "version", "created_at", "updated_at"`,
      [ownerId, current.id, original.postVersion]
    ));
    const archived = archivedRows[0];
    if (!archived) throw new ActionLedgerTargetStateConflictError('changed');
    return workspaceUndoResult(current.id, current.version, archived.version);
  }

  private async assertWorkspaceEmptyExceptUndoneChildren(
    transaction: QueryRunner,
    ownerId: string,
    projectId: string,
    childActionIds: readonly string[]
  ): Promise<void> {
    const children = await this.verifyCompletedTaskChildren(transaction, ownerId, projectId, childActionIds);
    const taskIds = children.map((child) => child.targetId);
    const rows: readonly WorkspaceEmptyRow[] = await transaction.query(`
      SELECT (
        EXISTS (
          SELECT 1 FROM "project_tasks" t
          WHERE t."owner_id" = $1 AND t."project_id" = $2 AND NOT (t."id" = ANY($3::uuid[]))
        ) OR EXISTS (
          SELECT 1 FROM "project_task_events" e
          WHERE e."owner_id" = $1 AND e."project_id" = $2
            AND (e."task_id" IS NULL OR NOT (e."task_id" = ANY($3::uuid[]))
              OR e."event_type" NOT IN ('task.created', 'task.status_changed')
              OR (e."event_type" = 'task.status_changed' AND e."details"->>'to' <> 'archived'))
        ) OR EXISTS (
          SELECT 1 FROM "project_task_suggestions" s WHERE s."owner_id" = $1 AND s."project_id" = $2
        ) OR EXISTS (
          SELECT 1 FROM "project_facts" f WHERE f."owner_id" = $1 AND f."project_id" = $2
        ) OR EXISTS (
          SELECT 1 FROM "conversations" c WHERE c."owner_id" = $1 AND c."project_id" = $2
        ) OR EXISTS (
          SELECT 1 FROM "home_conversations" h WHERE h."owner_id" = $1 AND h."workspace_id" = $2
        ) OR EXISTS (
          SELECT 1 FROM "project_chat_context" c WHERE c."owner_id" = $1 AND c."project_id" = $2
        ) OR EXISTS (
          SELECT 1 FROM "ai_runs" r WHERE r."owner_id" = $1 AND r."project_id" = $2
        )
      ) AS "has_content"`, [ownerId, projectId, taskIds]);
    if (rows[0]?.has_content) throw new ActionLedgerTargetStateConflictError('workspace_not_empty');
  }

  private async verifyCompletedTaskChildren(
    transaction: QueryRunner,
    ownerId: string,
    projectId: string,
    actionIds: readonly string[]
  ): Promise<readonly { readonly id: string; readonly targetId: string; readonly orderVersion: number }[]> {
    if (actionIds.length === 0) return [];
    const rows: readonly CompletedChildReceiptRow[] = await transaction.query(`
      SELECT c."id", c."action_kind", c."target_kind", c."target_id", c."undo_status", c."undo_action_id",
        (c."outcome"->>'destinationOrderVersion')::integer AS "creation_order_version",
        u."id" AS "compensation_id", u."action_kind" AS "compensation_kind", u."undo_status" AS "compensation_undo_status", u."undo_of_action_id" AS "compensation_undo_of",
        u."target_kind" AS "compensation_target_kind", u."target_id" AS "compensation_target_id",
        (u."outcome"->>'targetVersion')::integer AS "compensation_target_version",
        u."post_version" AS "compensation_post_version",
        t."owner_id" AS "task_owner_id", t."project_id" AS "task_project_id", t."status" AS "task_status", t."version" AS "task_version", t."position" AS "task_position",
        count(e."id") FILTER (WHERE e."event_type" = 'task.created') AS "created_event_count",
        max(e."details"->>'position') FILTER (WHERE e."event_type" = 'task.created') AS "created_position",
        count(e."id") FILTER (WHERE e."event_type" = 'task.status_changed' AND e."details"->>'to' = 'archived') AS "archive_event_count",
        count(e."id") FILTER (WHERE e."event_type" NOT IN ('task.created', 'task.status_changed')
          OR (e."event_type" = 'task.status_changed' AND e."details"->>'to' <> 'archived')) AS "other_event_count"
      FROM unnest($2::uuid[]) WITH ORDINALITY AS requested("id", "ordinal")
      LEFT JOIN "action_ledger_records" c ON c."owner_id" = $1 AND c."id" = requested."id"
      LEFT JOIN "action_ledger_records" u ON u."owner_id" = c."owner_id" AND u."id" = c."undo_action_id"
      LEFT JOIN "project_tasks" t ON t."owner_id" = $1 AND t."id" = c."target_id"
      LEFT JOIN "project_task_events" e ON e."owner_id" = $1 AND e."project_id" = $3 AND e."task_id" = t."id"
      GROUP BY c."id", c."action_kind", c."target_kind", c."target_id", c."undo_status", c."undo_action_id", c."outcome",
        u."id", u."action_kind", u."undo_status", u."undo_of_action_id", u."target_kind", u."target_id", u."post_version", u."outcome",
        t."owner_id", t."project_id", t."status", t."version", t."position", requested."ordinal"
      ORDER BY requested."ordinal"`, [ownerId, actionIds, projectId]);
    if (rows.length !== actionIds.length) throw new ActionLedgerTargetStateConflictError('workspace_not_empty');

    const children = rows.map((row) => {
      const orderVersion = Number(row.creation_order_version);
      const currentVersion = Number(row.task_version);
      if (!row.id || row.action_kind !== 'task.create' || row.target_kind !== 'task' || !row.target_id
        || row.undo_status !== 'undone' || !row.undo_action_id
        || row.compensation_id !== row.undo_action_id || row.compensation_kind !== 'undo' || row.compensation_undo_status !== 'not_reversible' || row.compensation_undo_of !== row.id
        || row.compensation_target_kind !== 'task' || row.compensation_target_id !== row.target_id
        || row.task_owner_id !== ownerId || row.task_project_id !== projectId || row.task_status !== 'archived'
        || !Number.isSafeInteger(orderVersion) || orderVersion <= 0 || !Number.isSafeInteger(currentVersion)
        || Number(row.compensation_target_version) !== currentVersion || Number(row.compensation_post_version) !== currentVersion || Number(row.created_event_count) !== 1
        || row.created_position === null || !/^\d+$/u.test(row.created_position) || Number(row.created_position) !== Number(row.task_position)
        || Number(row.archive_event_count) !== 1 || Number(row.other_event_count) !== 0) {
        throw new ActionLedgerTargetStateConflictError('workspace_not_empty');
      }
      return { id: row.id, targetId: row.target_id, orderVersion };
    });
    for (let index = 1; index < children.length; index += 1) {
      if (children[index - 1]!.orderVersion <= children[index]!.orderVersion) throw new ActionLedgerTargetStateConflictError('workspace_not_empty');
    }
    return children;
  }

  public async create(input: CreateProjectRecord): Promise<Project> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const project = await this.storageAccounting.runMutation(queryRunner, input.ownerId, async () => {
        await lockOwner(queryRunner, input.ownerId);
        const roots = await findReservedRoots(queryRunner, input.ownerId);
        const relativeRoot = input.relativeRoot;
        if (relativeRoot !== null && roots.some((root) => root.storage_kind === input.storageKind && projectRootsOverlap(relativeRoot, root.relative_root))) {
          throw new ProjectRootOverlapError();
        }
        const relativeRootKey = relativeRoot === null ? null : input.relativeRootKey ?? projectRootOverlapKey(relativeRoot);
        const rows: readonly ProjectRow[] = await queryRunner.query(
          `INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective", "status", "version", "created_at", "updated_at"`,
          [input.id, input.ownerId, input.name, input.slug, relativeRoot, relativeRootKey, input.storageKind, input.objective]
        );
        const row = rows[0];
        if (!row) throw new Error('The project could not be created.');
        if (relativeRoot !== null && row.relative_root_key !== null && row.storage_kind !== null) {
          await queryRunner.query(
            `INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
             VALUES ($1, $2, $2, $3, $4, $5, 'active')`,
            [input.ownerId, input.id, row.relative_root_key, row.storage_kind, row.relative_root]
          );
        }
        return toProject(row);
      }, fixedContentScope([{ entity: 'projects', id: input.id }]));
      await queryRunner.commitTransaction();
      return project;
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      if (isUniqueViolation(error)) {
        throw new ProjectNameConflictError();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async updateStatus(input: UpdateProjectStatusRecord): Promise<Project | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await lockOwner(queryRunner, input.ownerId);
      const projectState = await lockProjectWriteState(queryRunner, input.ownerId, input.projectId);
      if (projectState?.removalPending) throw new ProjectArchivedError();
      if (input.status === 'active') {
        const current = await queryRunner.query(
          'SELECT "relative_root_key" AS "relative_root", "storage_kind" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1',
          [input.ownerId, input.projectId]
        ) as readonly { relative_root: string | null; storage_kind: Project['storageKind'] }[];
        const roots = await queryRunner.query(
          `SELECT "relative_root_key" AS "relative_root" FROM "projects"
           WHERE "owner_id" = $1 AND "status" = 'active' AND "id" <> $2
             AND "relative_root_key" IS NOT NULL AND "storage_kind" IS NOT DISTINCT FROM $3`,
          [input.ownerId, input.projectId, current[0]?.storage_kind ?? null]
        ) as readonly { relative_root: string | null }[];
        const candidate = current[0]?.relative_root;
        if (candidate !== null && candidate !== undefined && roots.some((row) => row.relative_root !== null && projectRootsOverlap(candidate, row.relative_root))) {
          throw new ProjectRootOverlapError();
        }
      }
      // PostgreSQL UPDATE queries return [rows, rowCount], unlike SELECT queries.
      const [rows]: readonly [readonly ProjectRow[], number] = await queryRunner.query(
        `UPDATE "projects" SET "status" = $1, "version" = "version" + 1, "updated_at" = now()
         WHERE "owner_id" = $2 AND "id" = $3 AND "version" = $4
         RETURNING "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "storage_kind", "objective", "status", "version", "created_at", "updated_at"`,
        [input.status, input.ownerId, input.projectId, input.expectedVersion]
      );
      const updated = rows[0] ? toProject(rows[0]) : null;
      await queryRunner.commitTransaction();
      return updated;
    } catch (error: unknown) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
