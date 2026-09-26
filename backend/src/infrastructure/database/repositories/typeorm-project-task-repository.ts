import type { DataSource, QueryRunner } from 'typeorm';

import {
  ProjectTaskArchivedError,
  ProjectTaskArchivedProjectError,
  ProjectTaskIdempotencyReusedError,
  ProjectTaskNotFoundError,
  ProjectTaskOrderBoundaryError,
  ProjectTaskOrderConflictError,
  ProjectTaskStatusConflictError,
  ProjectTaskSuggestionResolvedError,
  ProjectTaskVersionConflictError
} from '@/modules/tasks/domain/project-task-errors';
import { canTransitionProjectTask } from '@/modules/tasks/domain/project-task-validation';
import type {
  ProjectTask,
  ProjectTaskFilter,
  ProjectTaskListSnapshot,
  ProjectTaskStatus,
  ProjectTaskSuggestion
} from '@/modules/tasks/domain/project-task';
import type {
  CreateProjectTaskRecord,
  CreateProjectTaskResult,
  IProjectTaskRepository,
  ReorderProjectTaskRecord,
  ResolveProjectTaskSuggestionRecord,
  ResolveProjectTaskSuggestionResult,
  UpdateProjectTaskRecord
} from '@/modules/tasks/repositories/project-task-repository';

interface TaskRow {
  readonly id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly details: string | null;
  readonly status: ProjectTaskStatus;
  readonly position: number;
  readonly version: number;
  readonly source_kind: 'user' | 'assistant_suggestion';
  readonly source_suggestion_id: string | null;
  readonly source_run_id: string | null;
  readonly source_conversation_id: string | null;
  readonly source_accepted_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly completed_at: Date | string | null;
  readonly archived_at: Date | string | null;
  readonly idempotency_snapshot?: unknown;
}

interface SuggestionRow {
  readonly id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly conversation_id: string;
  readonly ordinal?: number;
  readonly title: string;
  readonly details: string | null;
  readonly status: ProjectTaskSuggestion['status'];
  readonly version: number;
  readonly created_at: Date | string;
  readonly resolved_at: Date | string | null;
  readonly task_id: string | null;
}

interface ProjectRow {
  readonly status: 'active' | 'archived';
}

interface VersionRow {
  readonly version: number;
}

interface CountRow {
  readonly count: string | number;
}

interface PositionRow {
  readonly max_position: number | null;
}

const TASK_COLUMNS = `t."id", t."owner_id", t."project_id", t."title", t."details", t."status", t."position", t."version", t."source_kind", t."source_suggestion_id",
  s."run_id" AS "source_run_id", s."conversation_id" AS "source_conversation_id", s."resolved_at" AS "source_accepted_at",
  t."created_at", t."updated_at", t."completed_at", t."archived_at"`;

function asRows<T>(result: unknown): readonly T[] {
  if (!Array.isArray(result)) {
    throw new Error('The project task repository returned an unexpected query result.');
  }
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as readonly T[];
  }
  return result as readonly T[];
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('The project task repository returned an invalid timestamp.');
  }
  return date;
}

function nullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}

function toTask(row: TaskRow): ProjectTask {
  const isAssistant = row.source_kind === 'assistant_suggestion';
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    details: row.details,
    status: row.status,
    position: row.position,
    version: row.version,
    source: isAssistant ? {
      kind: 'assistant_suggestion',
      label: 'Added from an assistant suggestion · accepted by you',
      suggestionId: row.source_suggestion_id,
      runId: row.source_run_id,
      conversationId: row.source_conversation_id,
      acceptedAt: nullableDate(row.source_accepted_at)
    } : {
      kind: 'user',
      label: 'Added by you',
      suggestionId: null,
      runId: null,
      conversationId: null,
      acceptedAt: null
    },
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    completedAt: nullableDate(row.completed_at),
    archivedAt: nullableDate(row.archived_at)
  };
}

function toSuggestion(row: SuggestionRow): ProjectTaskSuggestion {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    title: row.title,
    details: row.details,
    status: row.status,
    version: row.version,
    taskId: row.task_id,
    source: { kind: 'assistant', label: 'Suggested by the assistant' },
    createdAt: toDate(row.created_at),
    resolvedAt: nullableDate(row.resolved_at)
  };
}

function snapshotToTask(value: unknown): ProjectTask {
  const parsed = typeof value === 'string' ? JSON.parse(value) as ProjectTask : value as ProjectTask;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || typeof parsed.title !== 'string') {
    throw new Error('The project task idempotency snapshot is invalid.');
  }
  return {
    ...parsed,
    createdAt: toDate(parsed.createdAt as unknown as string),
    updatedAt: toDate(parsed.updatedAt as unknown as string),
    completedAt: parsed.completedAt === null ? null : toDate(parsed.completedAt as unknown as string),
    archivedAt: parsed.archivedAt === null ? null : toDate(parsed.archivedAt as unknown as string),
    source: {
      ...parsed.source,
      acceptedAt: parsed.source.acceptedAt === null ? null : toDate(parsed.source.acceptedAt as unknown as string)
    }
  };
}

function serializeTask(task: ProjectTask): Record<string, unknown> {
  return {
    ...task,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    source: { ...task.source, acceptedAt: task.source.acceptedAt?.toISOString() ?? null }
  };
}

async function withTransaction<T>(dataSource: DataSource, action: (queryRunner: QueryRunner) => Promise<T>, isolation: 'READ COMMITTED' | 'REPEATABLE READ' = 'READ COMMITTED'): Promise<T> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction(isolation);
  try {
    const result = await action(queryRunner);
    await queryRunner.commitTransaction();
    return result;
  } catch (error: unknown) {
    if (queryRunner.isTransactionActive) {
      try {
        await queryRunner.rollbackTransaction();
      } catch {
        // Preserve the operation error; TypeORM still releases the connection below.
      }
    }
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function lockActiveProject(queryRunner: QueryRunner, ownerId: string, projectId: string): Promise<void> {
  const rows = asRows<ProjectRow>(await queryRunner.query(
    `SELECT "status" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 FOR UPDATE`,
    [ownerId, projectId]
  ));
  if (!rows[0]) {
    throw new ProjectTaskNotFoundError();
  }
  if (rows[0].status === 'archived') {
    throw new ProjectTaskArchivedProjectError();
  }
}

async function lockOrderState(queryRunner: QueryRunner, ownerId: string, projectId: string): Promise<number> {
  await queryRunner.query(
    `INSERT INTO "project_task_order_states" ("project_id", "owner_id")
     SELECT "id", "owner_id" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2
     ON CONFLICT ("project_id") DO NOTHING`,
    [ownerId, projectId]
  );
  const rows = asRows<VersionRow>(await queryRunner.query(
    `SELECT "version" FROM "project_task_order_states" WHERE "owner_id" = $1 AND "project_id" = $2 FOR UPDATE`,
    [ownerId, projectId]
  ));
  if (!rows[0]) {
    throw new ProjectTaskNotFoundError();
  }
  return rows[0].version;
}

async function readOrderVersion(queryRunner: QueryRunner, ownerId: string, projectId: string): Promise<number> {
  const rows = asRows<VersionRow>(await queryRunner.query(
    `SELECT "version" FROM "project_task_order_states" WHERE "owner_id" = $1 AND "project_id" = $2`,
    [ownerId, projectId]
  ));
  if (!rows[0]) {
    throw new ProjectTaskNotFoundError();
  }
  return rows[0].version;
}

async function bumpOrderVersion(queryRunner: QueryRunner, ownerId: string, projectId: string): Promise<number> {
  const rows = asRows<VersionRow>(await queryRunner.query(
    `UPDATE "project_task_order_states" SET "version" = "version" + 1, "updated_at" = now()
     WHERE "owner_id" = $1 AND "project_id" = $2 RETURNING "version"`,
    [ownerId, projectId]
  ));
  if (!rows[0]) {
    throw new ProjectTaskNotFoundError();
  }
  return rows[0].version;
}

async function countActiveTasks(queryRunner: QueryRunner, ownerId: string, projectId: string): Promise<number> {
  const rows = asRows<CountRow>(await queryRunner.query(
    `SELECT count(*) AS "count" FROM "project_tasks" WHERE "owner_id" = $1 AND "project_id" = $2 AND "status" <> 'archived'`,
    [ownerId, projectId]
  ));
  return Number(rows[0]?.count ?? 0);
}

async function maxTaskPosition(queryRunner: QueryRunner, ownerId: string, projectId: string): Promise<number> {
  const rows = asRows<PositionRow>(await queryRunner.query(
    `SELECT max("position") AS "max_position" FROM "project_tasks" WHERE "owner_id" = $1 AND "project_id" = $2 AND "status" <> 'archived'`,
    [ownerId, projectId]
  ));
  return Number(rows[0]?.max_position ?? -1);
}

async function loadTask(queryRunner: QueryRunner, ownerId: string, projectId: string, taskId: string, forUpdate = false): Promise<ProjectTask | null> {
  const rows = asRows<TaskRow>(await queryRunner.query(
    `SELECT ${TASK_COLUMNS} FROM "project_tasks" t
     LEFT JOIN "project_task_suggestions" s ON s."id" = t."source_suggestion_id"
     WHERE t."owner_id" = $1 AND t."project_id" = $2 AND t."id" = $3 LIMIT 1${forUpdate ? ' FOR UPDATE OF t' : ''}`,
    [ownerId, projectId, taskId]
  ));
  return rows[0] ? toTask(rows[0]) : null;
}

async function loadTaskBySource(queryRunner: QueryRunner, ownerId: string, projectId: string, suggestionId: string): Promise<ProjectTask | null> {
  const rows = asRows<TaskRow>(await queryRunner.query(
    `SELECT ${TASK_COLUMNS} FROM "project_tasks" t
     LEFT JOIN "project_task_suggestions" s ON s."id" = t."source_suggestion_id"
     WHERE t."owner_id" = $1 AND t."project_id" = $2 AND t."source_suggestion_id" = $3 LIMIT 1`,
    [ownerId, projectId, suggestionId]
  ));
  return rows[0] ? toTask(rows[0]) : null;
}

async function loadTaskList(queryRunner: QueryRunner, ownerId: string, projectId: string, filter: ProjectTaskFilter, orderVersion?: number): Promise<ProjectTaskListSnapshot> {
  const conditions: Record<ProjectTaskFilter, string> = {
    all: `t."status" <> 'archived'`,
    open: `t."status" IN ('todo', 'in_progress', 'blocked')`,
    completed: `t."status" = 'done'`,
    archived: `t."status" = 'archived'`
  };
  const rows = asRows<TaskRow>(await queryRunner.query(
    `SELECT ${TASK_COLUMNS} FROM "project_tasks" t
     LEFT JOIN "project_task_suggestions" s ON s."id" = t."source_suggestion_id"
     WHERE t."owner_id" = $1 AND t."project_id" = $2 AND ${conditions[filter]}
     ORDER BY t."position" ASC, t."id" ASC`,
    [ownerId, projectId]
  ));
  return { tasks: rows.map(toTask), orderVersion: orderVersion ?? await readOrderVersion(queryRunner, ownerId, projectId) };
}

async function insertTaskEvent(
  queryRunner: QueryRunner,
  input: {
    readonly ownerId: string;
    readonly projectId: string;
    readonly taskId?: string;
    readonly suggestionId?: string;
    readonly runId?: string;
    readonly eventType: 'task.created' | 'task.updated' | 'task.status_changed' | 'task.reordered' | 'task.suggestion_accepted' | 'task.suggestion_dismissed';
    readonly details: Record<string, string | number | readonly string[]>;
  }
): Promise<void> {
  await queryRunner.query(
    `INSERT INTO "project_task_events" ("owner_id", "project_id", "task_id", "suggestion_id", "run_id", "actor_kind", "actor_user_id", "event_type", "details")
     VALUES ($1, $2, $3, $4, $5, 'user', $1, $6, $7::jsonb)`,
    [input.ownerId, input.projectId, input.taskId ?? null, input.suggestionId ?? null, input.runId ?? null, input.eventType, JSON.stringify(input.details)]
  );
}

async function loadSuggestion(queryRunner: QueryRunner, ownerId: string, projectId: string, suggestionId: string, forUpdate = false): Promise<ProjectTaskSuggestion | null> {
  const rows = asRows<SuggestionRow>(await queryRunner.query(
    `SELECT s."id", s."owner_id", s."project_id", s."run_id", s."conversation_id", s."title", s."details", s."status", s."version", s."created_at", s."resolved_at",
            t."id" AS "task_id"
     FROM "project_task_suggestions" s
     LEFT JOIN "project_tasks" t ON t."source_suggestion_id" = s."id"
     WHERE s."owner_id" = $1 AND s."project_id" = $2 AND s."id" = $3 LIMIT 1${forUpdate ? ' FOR UPDATE OF s' : ''}`,
    [ownerId, projectId, suggestionId]
  ));
  return rows[0] ? toSuggestion(rows[0]) : null;
}

async function taskRowsForFilter(dataSource: DataSource, ownerId: string, projectId: string, filter: ProjectTaskFilter): Promise<ProjectTaskListSnapshot> {
  return withTransaction(dataSource, async (queryRunner) => {
    const versions = asRows<VersionRow>(await queryRunner.query(
      `SELECT s."version" FROM "project_task_order_states" s
       JOIN "projects" p ON p."id" = s."project_id" AND p."owner_id" = s."owner_id"
       WHERE s."owner_id" = $1 AND s."project_id" = $2`,
      [ownerId, projectId]
    ));
    if (!versions[0]) {
      throw new ProjectTaskNotFoundError();
    }
    return loadTaskList(queryRunner, ownerId, projectId, filter, versions[0].version);
  }, 'REPEATABLE READ');
}

async function appendTask(
  queryRunner: QueryRunner,
  input: { readonly ownerId: string; readonly projectId: string; readonly title: string; readonly details: string | null; readonly sourceSuggestionId?: string }
): Promise<ProjectTask> {
  const position = await countActiveTasks(queryRunner, input.ownerId, input.projectId);
  const rows = asRows<{ readonly id: string }>(await queryRunner.query(
    `INSERT INTO "project_tasks" ("owner_id", "project_id", "title", "details", "position", "source_kind", "source_suggestion_id")
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING "id"`,
    [input.ownerId, input.projectId, input.title, input.details, position, input.sourceSuggestionId ? 'assistant_suggestion' : 'user', input.sourceSuggestionId ?? null]
  ));
  const taskId = rows[0]?.id;
  if (!taskId) {
    throw new Error('The project task could not be created.');
  }
  const task = await loadTask(queryRunner, input.ownerId, input.projectId, taskId);
  if (!task) {
    throw new Error('The created project task could not be loaded.');
  }
  return task;
}

async function compactTaskPositions(queryRunner: QueryRunner, ownerId: string, projectId: string, removedPosition: number): Promise<void> {
  const maxPosition = await maxTaskPosition(queryRunner, ownerId, projectId);
  const count = await countActiveTasks(queryRunner, ownerId, projectId);
  const offset = maxPosition + count + 2;
  await queryRunner.query(
    `UPDATE "project_tasks" SET "position" = "position" + $3
     WHERE "owner_id" = $1 AND "project_id" = $2 AND "status" <> 'archived'`,
    [ownerId, projectId, offset]
  );
  await queryRunner.query(
    `UPDATE "project_tasks" SET "position" = CASE WHEN ("position" - $3) > $4 THEN "position" - $3 - 1 ELSE "position" - $3 END
     WHERE "owner_id" = $1 AND "project_id" = $2 AND "status" <> 'archived'`,
    [ownerId, projectId, offset, removedPosition]
  );
}

export class TypeOrmProjectTaskRepository implements IProjectTaskRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async listTasks(ownerId: string, projectId: string, filter: ProjectTaskFilter): Promise<ProjectTaskListSnapshot> {
    return taskRowsForFilter(this.dataSource, ownerId, projectId, filter);
  }

  public async createTask(input: CreateProjectTaskRecord): Promise<CreateProjectTaskResult> {
    return withTransaction(this.dataSource, async (queryRunner) => {
      await lockActiveProject(queryRunner, input.ownerId, input.projectId);
      const orderVersion = await lockOrderState(queryRunner, input.ownerId, input.projectId);
      const priorRows = asRows<{ readonly idempotency_fingerprint: string; readonly idempotency_snapshot: unknown }>(await queryRunner.query(
        `SELECT "request_fingerprint" AS "idempotency_fingerprint", "idempotency_snapshot" FROM "project_tasks"
         WHERE "owner_id" = $1 AND "project_id" = $2 AND "idempotency_key" = $3 LIMIT 1`,
        [input.ownerId, input.projectId, input.idempotencyKey]
      ));
      if (priorRows[0]) {
        if (priorRows[0].idempotency_fingerprint !== input.requestFingerprint || !priorRows[0].idempotency_snapshot) {
          throw new ProjectTaskIdempotencyReusedError();
        }
        const stored = typeof priorRows[0].idempotency_snapshot === 'string'
          ? JSON.parse(priorRows[0].idempotency_snapshot) as { task: unknown; orderVersion: number }
          : priorRows[0].idempotency_snapshot as { task: unknown; orderVersion: number };
        return { task: snapshotToTask(stored.task), orderVersion: stored.orderVersion, replayed: true };
      }

      const task = await appendTask(queryRunner, input);
      await queryRunner.query(
        `UPDATE "project_tasks" SET "idempotency_key" = $1, "request_fingerprint" = $2 WHERE "id" = $3`,
        [input.idempotencyKey, input.requestFingerprint, task.id]
      );
      await insertTaskEvent(queryRunner, { ownerId: input.ownerId, projectId: input.projectId, taskId: task.id, eventType: 'task.created', details: { sourceKind: 'user' } });
      const nextOrderVersion = await bumpOrderVersion(queryRunner, input.ownerId, input.projectId);
      const snapshot = { task: serializeTask(task), orderVersion: nextOrderVersion };
      await queryRunner.query('UPDATE "project_tasks" SET "idempotency_snapshot" = $1::jsonb WHERE "id" = $2', [JSON.stringify(snapshot), task.id]);
      return { task, orderVersion: nextOrderVersion, replayed: false };
    });
  }

  public async updateTask(input: UpdateProjectTaskRecord): Promise<{ readonly task: ProjectTask; readonly orderVersion: number }> {
    return withTransaction(this.dataSource, async (queryRunner) => {
      await lockActiveProject(queryRunner, input.ownerId, input.projectId);
      if (input.status === 'archived') {
        await lockOrderState(queryRunner, input.ownerId, input.projectId);
      }
      const current = await loadTask(queryRunner, input.ownerId, input.projectId, input.taskId, true);
      if (!current) {
        throw new ProjectTaskNotFoundError();
      }
      if (current.status === 'archived') {
        throw new ProjectTaskArchivedError();
      }
      if (current.version !== input.expectedVersion) {
        throw new ProjectTaskVersionConflictError();
      }
      if (input.status && !canTransitionProjectTask(current.status, input.status)) {
        throw new ProjectTaskStatusConflictError();
      }
      if (input.status && input.text) {
        throw new ProjectTaskStatusConflictError();
      }

      const setClauses: string[] = ['"version" = "version" + 1', '"updated_at" = now()'];
      const values: unknown[] = [];
      if (input.status) {
        values.push(input.status);
        setClauses.push(`"status" = $${values.length}`);
        if (input.status === 'done') {
          setClauses.push('"completed_at" = COALESCE("completed_at", now())');
        }
        if (input.status === 'archived') {
          setClauses.push('"archived_at" = now()');
        }
      } else if (input.text) {
        if (input.text.title !== undefined) {
          values.push(input.text.title);
          setClauses.push(`"title" = $${values.length}`);
        }
        if ('details' in input.text) {
          values.push(input.text.details ?? null);
          setClauses.push(`"details" = $${values.length}`);
        }
      }
      values.push(input.ownerId, input.projectId, input.taskId, input.expectedVersion);
      const whereOffset = values.length - 3;
      const updated = asRows<{ readonly id: string }>(await queryRunner.query(
        `UPDATE "project_tasks" SET ${setClauses.join(', ')}
         WHERE "owner_id" = $${whereOffset} AND "project_id" = $${whereOffset + 1} AND "id" = $${whereOffset + 2} AND "version" = $${whereOffset + 3}
         RETURNING "id"`,
        values
      ));
      if (!updated[0]) {
        throw new ProjectTaskVersionConflictError();
      }
      const task = await loadTask(queryRunner, input.ownerId, input.projectId, input.taskId);
      if (!task) {
        throw new ProjectTaskNotFoundError();
      }
      if (input.status) {
        await insertTaskEvent(queryRunner, {
          ownerId: input.ownerId,
          projectId: input.projectId,
          taskId: task.id,
          eventType: 'task.status_changed',
          details: { from: current.status, to: input.status }
        });
        if (input.status === 'archived') {
          await compactTaskPositions(queryRunner, input.ownerId, input.projectId, current.position);
          const orderVersion = await bumpOrderVersion(queryRunner, input.ownerId, input.projectId);
          return { task, orderVersion };
        }
      } else {
        await insertTaskEvent(queryRunner, {
          ownerId: input.ownerId,
          projectId: input.projectId,
          taskId: task.id,
          eventType: 'task.updated',
          details: { fields: [ ...(input.text?.title !== undefined ? ['title'] : []), ...(input.text && 'details' in input.text ? ['details'] : []) ] }
        });
      }
      return { task, orderVersion: await readOrderVersion(queryRunner, input.ownerId, input.projectId) };
    });
  }

  public async reorderTask(input: ReorderProjectTaskRecord): Promise<ProjectTaskListSnapshot> {
    return withTransaction(this.dataSource, async (queryRunner) => {
      await lockActiveProject(queryRunner, input.ownerId, input.projectId);
      const currentOrderVersion = await lockOrderState(queryRunner, input.ownerId, input.projectId);
      if (currentOrderVersion !== input.expectedOrderVersion) {
        throw new ProjectTaskOrderConflictError();
      }
      const current = await loadTask(queryRunner, input.ownerId, input.projectId, input.taskId, true);
      if (!current) {
        throw new ProjectTaskNotFoundError();
      }
      if (current.status === 'archived') {
        throw new ProjectTaskArchivedError();
      }
      const neighborPosition = current.position + (input.direction === 'up' ? -1 : 1);
      const neighbors = asRows<{ readonly id: string; readonly position: number }>(await queryRunner.query(
        `SELECT "id", "position" FROM "project_tasks" WHERE "owner_id" = $1 AND "project_id" = $2 AND "status" <> 'archived' AND "position" = $3 LIMIT 1 FOR UPDATE`,
        [input.ownerId, input.projectId, neighborPosition]
      ));
      const neighbor = neighbors[0];
      if (!neighbor) {
        throw new ProjectTaskOrderBoundaryError();
      }
      const offset = (await maxTaskPosition(queryRunner, input.ownerId, input.projectId)) + 2;
      await queryRunner.query(
        `UPDATE "project_tasks" SET "position" = "position" + $4 WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = ANY($3::uuid[])`,
        [input.ownerId, input.projectId, [current.id, neighbor.id], offset]
      );
      await queryRunner.query('UPDATE "project_tasks" SET "position" = $1 WHERE "owner_id" = $2 AND "project_id" = $3 AND "id" = $4', [neighbor.position, input.ownerId, input.projectId, current.id]);
      await queryRunner.query('UPDATE "project_tasks" SET "position" = $1 WHERE "owner_id" = $2 AND "project_id" = $3 AND "id" = $4', [current.position, input.ownerId, input.projectId, neighbor.id]);
      await insertTaskEvent(queryRunner, {
        ownerId: input.ownerId,
        projectId: input.projectId,
        taskId: current.id,
        eventType: 'task.reordered',
        details: { from: current.position, to: neighbor.position }
      });
      const orderVersion = await bumpOrderVersion(queryRunner, input.ownerId, input.projectId);
      return loadTaskList(queryRunner, input.ownerId, input.projectId, 'all', orderVersion);
    });
  }

  public async listSuggestions(ownerId: string, projectId: string, filter: { readonly status: 'all' | 'pending'; readonly conversationId?: string }): Promise<readonly ProjectTaskSuggestion[]> {
    const rows = asRows<SuggestionRow>(await this.dataSource.query(
      `SELECT s."id", s."owner_id", s."project_id", s."run_id", s."conversation_id", s."title", s."details", s."status", s."version", s."created_at", s."resolved_at",
              (SELECT t."id" FROM "project_tasks" t WHERE t."source_suggestion_id" = s."id" LIMIT 1) AS "task_id"
       FROM "project_task_suggestions" s
       JOIN "projects" p ON p."id" = s."project_id" AND p."owner_id" = s."owner_id"
       WHERE s."owner_id" = $1 AND s."project_id" = $2
         AND ($3::text = 'all' OR s."status" = 'pending')
         AND ($4::uuid IS NULL OR s."conversation_id" = $4)
       ORDER BY s."created_at" ASC, s."id" ASC`,
      [ownerId, projectId, filter.status, filter.conversationId ?? null]
    ));
    return rows.map(toSuggestion);
  }

  public async resolveSuggestion(input: ResolveProjectTaskSuggestionRecord): Promise<ResolveProjectTaskSuggestionResult> {
    return withTransaction(this.dataSource, async (queryRunner) => {
      await lockActiveProject(queryRunner, input.ownerId, input.projectId);
      if (input.decision === 'accepted') {
        await lockOrderState(queryRunner, input.ownerId, input.projectId);
      }
      const current = await loadSuggestion(queryRunner, input.ownerId, input.projectId, input.suggestionId, true);
      if (!current) {
        throw new ProjectTaskNotFoundError();
      }
      if (current.status === 'accepted') {
        if (input.decision !== 'accepted') {
          throw new ProjectTaskSuggestionResolvedError();
        }
        const task = await loadTaskBySource(queryRunner, input.ownerId, input.projectId, current.id);
        if (!task) {
          throw new Error('The accepted task suggestion has no linked task.');
        }
        return { decision: 'accepted', task, taskSuggestion: current, orderVersion: await readOrderVersion(queryRunner, input.ownerId, input.projectId) };
      }
      if (current.status === 'dismissed') {
        if (input.decision === 'dismissed') {
          return { decision: 'dismissed', taskSuggestion: current };
        }
        throw new ProjectTaskSuggestionResolvedError();
      }
      if (current.version !== input.expectedVersion) {
        throw new ProjectTaskVersionConflictError();
      }

      if (input.decision === 'dismissed') {
        await queryRunner.query(
          `UPDATE "project_task_suggestions" SET "status" = 'dismissed', "version" = "version" + 1, "resolved_by_user_id" = $1, "resolved_at" = now()
           WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3 AND "version" = $4`,
          [input.ownerId, input.projectId, input.suggestionId, input.expectedVersion]
        );
        const suggestion = await loadSuggestion(queryRunner, input.ownerId, input.projectId, input.suggestionId);
        if (!suggestion) {
          throw new ProjectTaskNotFoundError();
        }
        await insertTaskEvent(queryRunner, {
          ownerId: input.ownerId,
          projectId: input.projectId,
          suggestionId: current.id,
          runId: current.runId,
          eventType: 'task.suggestion_dismissed',
          details: {}
        });
        return { decision: 'dismissed', taskSuggestion: suggestion };
      }

      const task = await appendTask(queryRunner, {
        ownerId: input.ownerId,
        projectId: input.projectId,
        title: input.title ?? current.title,
        details: input.details === undefined ? current.details : input.details,
        sourceSuggestionId: current.id
      });
      await queryRunner.query(
        `UPDATE "project_task_suggestions" SET "status" = 'accepted', "version" = "version" + 1, "resolved_by_user_id" = $1, "resolved_at" = now()
         WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3 AND "version" = $4`,
        [input.ownerId, input.projectId, input.suggestionId, input.expectedVersion]
      );
      const suggestion = await loadSuggestion(queryRunner, input.ownerId, input.projectId, input.suggestionId);
      if (!suggestion) {
        throw new ProjectTaskNotFoundError();
      }
      await insertTaskEvent(queryRunner, {
        ownerId: input.ownerId,
        projectId: input.projectId,
        taskId: task.id,
        eventType: 'task.created',
        details: { sourceKind: 'assistant_suggestion' }
      });
      await insertTaskEvent(queryRunner, {
        ownerId: input.ownerId,
        projectId: input.projectId,
        taskId: task.id,
        suggestionId: current.id,
        runId: current.runId,
        eventType: 'task.suggestion_accepted',
        details: { sourceKind: 'assistant_suggestion' }
      });
      const orderVersion = await bumpOrderVersion(queryRunner, input.ownerId, input.projectId);
      const linkedTask = await loadTask(queryRunner, input.ownerId, input.projectId, task.id);
      if (!linkedTask) {
        throw new ProjectTaskNotFoundError();
      }
      return { decision: 'accepted', task: linkedTask, taskSuggestion: suggestion, orderVersion };
    });
  }
}
