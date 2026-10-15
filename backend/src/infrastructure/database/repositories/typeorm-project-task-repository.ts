import type { DataSource, QueryRunner } from 'typeorm';

import type { ActionLedgerReversibleFields } from '@/modules/action-ledger/domain/action-ledger-types';
import type { GlobalTaskQueryCursorPosition, GlobalTaskQueryFilters, GlobalTaskQueryItem } from '@/modules/tasks/domain/global-task-query';
import {
  ProjectTaskArchivedError,
  ProjectTaskArchivedProjectError,
  ProjectTaskIdempotencyReusedError,
  ProjectTaskMoveConflictError,
  ProjectTaskNotFoundError,
  ProjectTaskOrderBoundaryError,
  ProjectTaskOrderConflictError,
  ProjectTaskStatusConflictError,
  ProjectTaskSuggestionResolvedError,
  ProjectTaskValidationError,
  ProjectTaskVersionConflictError
} from '@/modules/tasks/domain/project-task-errors';
import { canTransitionProjectTask } from '@/modules/tasks/domain/project-task-validation';
import { normalizeTaskSubtasks } from '@/modules/tasks/domain/task-planning-validation';
import { isTaskChecklistComplete, resolveTaskChecklistState } from '@/modules/tasks/domain/task-checklist-status';
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
import type { IGlobalTaskQueryRepository, GlobalTaskQueryRepositoryPage } from '@/modules/tasks/repositories/global-task-query-repository';
import type {
  AppliedTaskMutation,
  ArchiveTaskMutationInput,
  CreateTaskMutationInput,
  ITaskMutationParticipant,
  MoveTaskMutationInput,
  UpdateTaskMutationInput
} from '@/modules/tasks/repositories/task-mutation-participant';

interface TaskRow {
  readonly id: string;
  readonly owner_id: string;
  readonly project_id: string | null;
  readonly title: string;
  readonly details: string | null;
  readonly importance: ProjectTask['importance'];
  readonly deadline: string | null;
  readonly subtasks: ProjectTask['subtasks'];
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

interface GlobalTaskQueryRow extends TaskRow {
  readonly workspace_id: string | null;
  readonly workspace_name: string | null;
  readonly workspace_status: 'active' | 'archived' | null;
  readonly cursor_created_at: string;
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
  readonly subtasks: ProjectTaskSuggestion['subtasks'];
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

const TASK_COLUMNS = `t."id", t."owner_id", t."project_id", t."title", t."details", t."importance", t."deadline"::text AS "deadline", t."subtasks", t."status", t."position", t."version", t."source_kind", t."source_suggestion_id",
  t."source_run_id", t."source_conversation_id", t."source_accepted_at",
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
    importance: row.importance ?? 'medium',
    deadline: row.deadline ?? null,
    subtasks: row.subtasks ?? [],
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

function toGlobalTaskQueryItem(row: GlobalTaskQueryRow): GlobalTaskQueryItem {
  if (row.project_id === null) {
    return { task: toTask(row), collection: 'inbox', workspace: null };
  }
  if (!row.workspace_id || !row.workspace_name || !row.workspace_status) {
    throw new Error('The global task query returned a task without its owner-scoped workspace.');
  }
  return {
    task: toTask(row),
    collection: 'workspace',
    workspace: { id: row.workspace_id, name: row.workspace_name, status: row.workspace_status }
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}

function toSuggestion(row: SuggestionRow): ProjectTaskSuggestion {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    title: row.title,
    details: row.details,
    subtasks: row.subtasks ?? [],
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
    importance: parsed.importance ?? 'medium',
    deadline: parsed.deadline ?? null,
    subtasks: parsed.subtasks ?? [],
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
     WHERE t."owner_id" = $1 AND t."project_id" = $2 AND t."id" = $3 LIMIT 1${forUpdate ? ' FOR UPDATE OF t' : ''}`,
    [ownerId, projectId, taskId]
  ));
  return rows[0] ? toTask(rows[0]) : null;
}

async function loadTaskBySource(queryRunner: QueryRunner, ownerId: string, projectId: string, suggestionId: string): Promise<ProjectTask | null> {
  const rows = asRows<TaskRow>(await queryRunner.query(
    `SELECT ${TASK_COLUMNS} FROM "project_tasks" t
     WHERE t."owner_id" = $1 AND t."source_suggestion_project_id" = $2 AND t."source_suggestion_id" = $3 LIMIT 1`,
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
    `SELECT s."id", s."owner_id", s."project_id", s."run_id", s."conversation_id", s."title", s."details", s."subtasks", s."status", s."version", s."created_at", s."resolved_at",
            t."id" AS "task_id"
     FROM "project_task_suggestions" s
     LEFT JOIN "project_tasks" t ON t."owner_id" = s."owner_id"
       AND t."source_suggestion_project_id" = s."project_id"
       AND t."source_suggestion_id" = s."id"
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
  input: {
    readonly ownerId: string;
    readonly projectId: string;
    readonly title: string;
    readonly details: string | null;
    readonly sourceSuggestion?: { readonly id: string; readonly projectId: string; readonly runId: string; readonly conversationId: string };
    readonly importance: ProjectTask['importance'];
    readonly deadline: string | null;
    readonly subtasks: ProjectTask['subtasks'];
  }
): Promise<ProjectTask> {
  const position = await countActiveTasks(queryRunner, input.ownerId, input.projectId);
  const sourceSuggestion = input.sourceSuggestion;
  const rows = asRows<{ readonly id: string }>(await queryRunner.query(
    `INSERT INTO "project_tasks" ("owner_id", "project_id", "title", "details", "position", "source_kind", "source_suggestion_id", "source_suggestion_project_id", "source_run_id", "source_conversation_id", "source_accepted_at", "importance", "deadline", "subtasks", "status", "completed_at")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $7::uuid IS NOT NULL THEN now() ELSE NULL END, $11, $12, $13::jsonb, $14::"project_task_status", CASE WHEN $14::"project_task_status" = 'done' THEN now() ELSE NULL END) RETURNING "id"`,
    [input.ownerId, input.projectId, input.title, input.details, position, sourceSuggestion ? 'assistant_suggestion' : 'user', sourceSuggestion?.id ?? null, sourceSuggestion?.projectId ?? null, sourceSuggestion?.runId ?? null, sourceSuggestion?.conversationId ?? null, input.importance, input.deadline, JSON.stringify(input.subtasks), isTaskChecklistComplete(input.subtasks) ? 'done' : 'todo']
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

function collectionPredicate(projectId: string | null, alias: string, parameter = 2): string {
  return projectId === null ? `${alias}."project_id" IS NULL` : `${alias}."project_id" = $${parameter}`;
}

function collectionValues(ownerId: string, projectId: string | null): unknown[] {
  return projectId === null ? [ownerId] : [ownerId, projectId];
}

async function loadTaskByOwner(queryRunner: QueryRunner, ownerId: string, taskId: string, forUpdate = false): Promise<ProjectTask | null> {
  const rows = asRows<TaskRow>(await queryRunner.query(
    `SELECT ${TASK_COLUMNS} FROM "project_tasks" t
     WHERE t."owner_id" = $1 AND t."id" = $2 LIMIT 1${forUpdate ? ' FOR UPDATE OF t' : ''}`,
    [ownerId, taskId]
  ));
  return rows[0] ? toTask(rows[0]) : null;
}

async function lockCollectionProject(queryRunner: QueryRunner, ownerId: string, projectId: string | null): Promise<void> {
  if (projectId !== null) {
    await lockActiveProject(queryRunner, ownerId, projectId);
  }
}

async function lockCollectionProjects(queryRunner: QueryRunner, ownerId: string, projectIds: readonly (string | null)[]): Promise<void> {
  const ids = [...new Set(projectIds.filter((projectId): projectId is string => projectId !== null))].sort();
  for (const projectId of ids) {
    await lockActiveProject(queryRunner, ownerId, projectId);
  }
}

async function lockCollectionOrderState(queryRunner: QueryRunner, ownerId: string, projectId: string | null): Promise<number> {
  if (projectId !== null) {
    return lockOrderState(queryRunner, ownerId, projectId);
  }
  const rows = asRows<VersionRow>(await queryRunner.query(
    `SELECT "version" FROM "project_task_order_states" WHERE "owner_id" = $1 AND "project_id" IS NULL FOR UPDATE`,
    [ownerId]
  ));
  if (!rows[0]) {
    throw new ProjectTaskNotFoundError();
  }
  return rows[0].version;
}

async function readCollectionOrderVersion(queryRunner: QueryRunner, ownerId: string, projectId: string | null): Promise<number> {
  if (projectId !== null) {
    return readOrderVersion(queryRunner, ownerId, projectId);
  }
  const rows = asRows<VersionRow>(await queryRunner.query(
    `SELECT "version" FROM "project_task_order_states" WHERE "owner_id" = $1 AND "project_id" IS NULL`,
    [ownerId]
  ));
  if (!rows[0]) {
    throw new ProjectTaskNotFoundError();
  }
  return rows[0].version;
}

async function bumpCollectionOrderVersion(queryRunner: QueryRunner, ownerId: string, projectId: string | null): Promise<number> {
  if (projectId !== null) {
    return bumpOrderVersion(queryRunner, ownerId, projectId);
  }
  const rows = asRows<VersionRow>(await queryRunner.query(
    `UPDATE "project_task_order_states" SET "version" = "version" + 1, "updated_at" = now()
     WHERE "owner_id" = $1 AND "project_id" IS NULL RETURNING "version"`,
    [ownerId]
  ));
  if (!rows[0]) {
    throw new ProjectTaskNotFoundError();
  }
  return rows[0].version;
}

async function countCollectionTasks(queryRunner: QueryRunner, ownerId: string, projectId: string | null): Promise<number> {
  const rows = asRows<CountRow>(await queryRunner.query(
    `SELECT count(*) AS "count" FROM "project_tasks" t
     WHERE t."owner_id" = $1 AND ${collectionPredicate(projectId, 't')} AND t."status" <> 'archived'`,
    collectionValues(ownerId, projectId)
  ));
  return Number(rows[0]?.count ?? 0);
}

async function maxCollectionTaskPosition(queryRunner: QueryRunner, ownerId: string, projectId: string | null): Promise<number> {
  const rows = asRows<PositionRow>(await queryRunner.query(
    `SELECT max(t."position") AS "max_position" FROM "project_tasks" t
     WHERE t."owner_id" = $1 AND ${collectionPredicate(projectId, 't')} AND t."status" <> 'archived'`,
    collectionValues(ownerId, projectId)
  ));
  return Number(rows[0]?.max_position ?? -1);
}

async function compactCollectionTaskPositions(queryRunner: QueryRunner, ownerId: string, projectId: string | null, removedPosition: number): Promise<void> {
  const maxPosition = await maxCollectionTaskPosition(queryRunner, ownerId, projectId);
  const count = await countCollectionTasks(queryRunner, ownerId, projectId);
  const offset = maxPosition + count + 2;
  const predicate = collectionPredicate(projectId, 't', 3);
  const values = projectId === null ? [ownerId, offset] : [ownerId, projectId, offset];
  const offsetParameter = projectId === null ? '$2' : '$3';
  const removedParameter = projectId === null ? '$3' : '$4';
  await queryRunner.query(
    `UPDATE "project_tasks" t SET "position" = t."position" + ${offsetParameter}
     WHERE t."owner_id" = $1 AND ${predicate} AND t."status" <> 'archived'`,
    values
  );
  const secondValues = projectId === null ? [ownerId, offset, removedPosition] : [ownerId, projectId, offset, removedPosition];
  await queryRunner.query(
    `UPDATE "project_tasks" t
     SET "position" = CASE WHEN (t."position" - ${offsetParameter}) > ${removedParameter}
       THEN t."position" - ${offsetParameter} - 1 ELSE t."position" - ${offsetParameter} END
     WHERE t."owner_id" = $1 AND ${predicate} AND t."status" <> 'archived'`,
    secondValues
  );
}

async function insertTaskMutationEvent(queryRunner: QueryRunner, input: {
  readonly ownerId: string;
  readonly projectId: string | null;
  readonly taskId: string;
  readonly actorKind: 'manual' | 'assistant';
  readonly eventType: 'task.created' | 'task.updated' | 'task.status_changed';
  readonly details: Record<string, string | number | readonly string[]>;
}): Promise<void> {
  await queryRunner.query(
    `INSERT INTO "project_task_events" ("owner_id", "project_id", "task_id", "actor_kind", "actor_user_id", "event_type", "details")
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [input.ownerId, input.projectId, input.taskId, input.actorKind === 'manual' ? 'user' : 'assistant', input.actorKind === 'manual' ? input.ownerId : null, input.eventType, JSON.stringify(input.details)]
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function taskReversibleFields(before: ProjectTask, after: ProjectTask): { readonly fields: ActionLedgerReversibleFields; readonly undoStatus: 'available' | 'not_reversible' } {
  const changes: Partial<Record<keyof ActionLedgerReversibleFields, { readonly before: unknown; readonly after: unknown }>> = {};
  const add = (field: keyof ActionLedgerReversibleFields, oldValue: unknown, newValue: unknown): void => {
    if (canonicalJson(oldValue) !== canonicalJson(newValue)) {
      changes[field] = { before: oldValue, after: newValue };
    }
  };
  add('title', before.title, after.title);
  add('details', before.details, after.details);
  add('status', before.status, after.status);
  add('position', before.position, after.position);
  add('projectId', before.projectId, after.projectId);
  add('importance', before.importance, after.importance);
  add('deadline', before.deadline, after.deadline);
  add('archivedAt', before.archivedAt?.toISOString() ?? null, after.archivedAt?.toISOString() ?? null);
  add('subtasks', before.subtasks, after.subtasks);
  const fields = changes as ActionLedgerReversibleFields;
  return { fields, undoStatus: Object.keys(fields).length > 0 ? 'available' : 'not_reversible' };
}

function taskOutcome(input: {
  readonly task: ProjectTask;
  readonly sourceOrderVersion?: number;
  readonly destinationOrderVersion?: number;
}) {
  return {
    targetId: input.task.id,
    targetVersion: input.task.version,
    ...(input.sourceOrderVersion === undefined ? {} : { sourceOrderVersion: input.sourceOrderVersion }),
    ...(input.destinationOrderVersion === undefined ? {} : { destinationOrderVersion: input.destinationOrderVersion })
  };
}

function makeTaskMutation(input: {
  readonly task: ProjectTask;
  readonly before: ProjectTask | null;
  readonly sourceOrderVersion?: number;
  readonly destinationOrderVersion?: number;
  readonly create?: boolean;
}): AppliedTaskMutation {
  const reversible = input.create
    ? { fields: {} as ActionLedgerReversibleFields, undoStatus: 'available' as const }
    : taskReversibleFields(input.before as ProjectTask, input.task);
  return {
    preVersion: input.before?.version ?? null,
    postVersion: input.task.version,
    reversibleFields: reversible.fields,
    outcome: taskOutcome(input),
    undoStatus: reversible.undoStatus,
    task: input.task
  };
}

export class TypeOrmProjectTaskRepository implements IProjectTaskRepository, IGlobalTaskQueryRepository, ITaskMutationParticipant<QueryRunner> {
  public constructor(private readonly dataSource: DataSource) {}

  /** Creates the task within the action-ledger transaction. */
  public async createInTransaction(queryRunner: QueryRunner, input: CreateTaskMutationInput): Promise<AppliedTaskMutation> {
    await lockCollectionProject(queryRunner, input.ownerId, input.projectId);
    const currentOrderVersion = await lockCollectionOrderState(queryRunner, input.ownerId, input.projectId);
    if (input.expectedOrderVersion !== undefined && input.expectedOrderVersion !== currentOrderVersion) {
      throw new ProjectTaskOrderConflictError();
    }
    const position = await countCollectionTasks(queryRunner, input.ownerId, input.projectId);
    const initialStatus = isTaskChecklistComplete(input.subtasks) ? 'done' : 'todo';
    const rows = asRows<{ readonly id: string }>(await queryRunner.query(
      `INSERT INTO "project_tasks" ("id", "owner_id", "project_id", "title", "details", "position", "source_kind", "source_suggestion_id", "source_suggestion_project_id", "source_run_id", "source_conversation_id", "source_accepted_at", "importance", "deadline", "subtasks", "status", "completed_at")
       VALUES ($1, $2, $3, $4, $5, $6, 'user', NULL, NULL, NULL, NULL, NULL, $7, $8, $9::jsonb, $10::"project_task_status", CASE WHEN $10::"project_task_status" = 'done' THEN now() ELSE NULL END)
       RETURNING "id"`,
      [input.taskId, input.ownerId, input.projectId, input.title, input.details, position, input.importance, input.deadline, JSON.stringify(input.subtasks), initialStatus]
    ));
    if (!rows[0]) {
      throw new Error('The task could not be created within the action transaction.');
    }
    const task = await loadTaskByOwner(queryRunner, input.ownerId, input.taskId);
    if (!task) {
      throw new Error('The created task could not be loaded within the action transaction.');
    }
    await insertTaskMutationEvent(queryRunner, {
      ownerId: input.ownerId,
      projectId: input.projectId,
      taskId: task.id,
      actorKind: input.actorKind,
      eventType: 'task.created',
      details: { sourceKind: 'user' }
    });
    const nextOrderVersion = await bumpCollectionOrderVersion(queryRunner, input.ownerId, input.projectId);
    return makeTaskMutation({ task, before: null, destinationOrderVersion: nextOrderVersion, create: true });
  }

  /** Updates an owner-owned task without opening a nested transaction. */
  public async updateInTransaction(queryRunner: QueryRunner, input: UpdateTaskMutationInput): Promise<AppliedTaskMutation> {
    const observed = await loadTaskByOwner(queryRunner, input.ownerId, input.taskId);
    if (!observed) {
      throw new ProjectTaskNotFoundError();
    }
    if (input.expectedProjectId !== undefined && observed.projectId !== input.expectedProjectId) {
      throw new ProjectTaskNotFoundError();
    }
    await lockCollectionProject(queryRunner, input.ownerId, observed.projectId);
    const current = await loadTaskByOwner(queryRunner, input.ownerId, input.taskId, true);
    if (!current) {
      throw new ProjectTaskNotFoundError();
    }
    if (current.projectId !== observed.projectId) {
      throw new ProjectTaskMoveConflictError();
    }
    if (input.expectedProjectId !== undefined && current.projectId !== input.expectedProjectId) {
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

    const text = {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.details === undefined ? {} : { details: input.details }),
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
      ...(input.subtasks === undefined ? {} : { subtasks: input.subtasks })
    };
    const hasText = Object.keys(text).length > 0;
    if (!input.status && !hasText) {
      throw new ProjectTaskValidationError([{ field: 'request', message: 'Provide at least one task field to update.' }]);
    }

    const setClauses: string[] = ['"version" = "version" + 1', '"updated_at" = now()'];
    const values: unknown[] = [];
    const completion = resolveTaskChecklistState({
      current,
      ...(input.status ? { status: input.status } : {}),
      ...(input.subtasks === undefined ? {} : { subtasks: input.subtasks })
    });
    if (input.status || completion.status !== current.status) {
      values.push(completion.status);
      setClauses.push(`"status" = $${values.length}`);
      setClauses.push(completion.status === 'done' ? '"completed_at" = COALESCE("completed_at", now())' : '"completed_at" = NULL');
    }
    if (input.status === 'done') {
      values.push(JSON.stringify(completion.subtasks));
      setClauses.push(`"subtasks" = $${values.length}::jsonb`);
    }
    if (input.title !== undefined) {
      values.push(input.title);
      setClauses.push(`"title" = $${values.length}`);
    }
    if (input.details !== undefined) {
      values.push(input.details);
      setClauses.push(`"details" = $${values.length}`);
    }
    if (input.importance !== undefined) {
      values.push(input.importance);
      setClauses.push(`"importance" = $${values.length}`);
    }
    if (input.deadline !== undefined) {
      values.push(input.deadline);
      setClauses.push(`"deadline" = $${values.length}`);
    }
    if (input.subtasks !== undefined) {
      values.push(JSON.stringify(completion.subtasks));
      setClauses.push(`"subtasks" = $${values.length}::jsonb`);
    }
    values.push(input.ownerId, input.taskId, input.expectedVersion);
    const whereOffset = values.length - 2;
    const updated = asRows<{ readonly id: string }>(await queryRunner.query(
      `UPDATE "project_tasks" SET ${setClauses.join(', ')}
       WHERE "owner_id" = $${whereOffset} AND "id" = $${whereOffset + 1} AND "version" = $${whereOffset + 2}
       RETURNING "id"`,
      values
    ));
    if (!updated[0]) {
      throw new ProjectTaskVersionConflictError();
    }
    const task = await loadTaskByOwner(queryRunner, input.ownerId, input.taskId);
    if (!task) {
      throw new ProjectTaskNotFoundError();
    }
    if (task.status !== current.status) {
      await insertTaskMutationEvent(queryRunner, {
        ownerId: input.ownerId,
        projectId: current.projectId,
        taskId: task.id,
        actorKind: input.actorKind,
        eventType: 'task.status_changed',
        details: { from: current.status, to: task.status }
      });
    }
    if (hasText) {
      await insertTaskMutationEvent(queryRunner, {
        ownerId: input.ownerId,
        projectId: current.projectId,
        taskId: task.id,
        actorKind: input.actorKind,
        eventType: 'task.updated',
        details: { fields: Object.keys(text) }
      });
    }
    return makeTaskMutation({
      task,
      before: current,
      sourceOrderVersion: await readCollectionOrderVersion(queryRunner, input.ownerId, current.projectId)
    });
  }

  /** Moves a task while holding both collection rows and preserving its stable source fields. */
  public async moveInTransaction(queryRunner: QueryRunner, input: MoveTaskMutationInput): Promise<AppliedTaskMutation> {
    const observed = await loadTaskByOwner(queryRunner, input.ownerId, input.taskId);
    if (!observed) {
      throw new ProjectTaskNotFoundError();
    }
    if (observed.projectId === input.destinationProjectId) {
      throw new ProjectTaskMoveConflictError();
    }
    await lockCollectionProjects(queryRunner, input.ownerId, [observed.projectId, input.destinationProjectId]);
    const collections = [observed.projectId, input.destinationProjectId]
      .sort((left, right) => (left === null ? '0:inbox' : `1:${left}`).localeCompare(right === null ? '0:inbox' : `1:${right}`));
    const orderVersions = new Map<string, number>();
    for (const projectId of collections) {
      orderVersions.set(projectId ?? 'inbox', await lockCollectionOrderState(queryRunner, input.ownerId, projectId));
    }
    const sourceVersion = orderVersions.get(observed.projectId ?? 'inbox');
    const destinationVersion = orderVersions.get(input.destinationProjectId ?? 'inbox');
    if (sourceVersion === undefined || destinationVersion === undefined) {
      throw new Error('A task collection order state was not locked.');
    }
    if (input.expectedSourceOrderVersion !== undefined && sourceVersion !== input.expectedSourceOrderVersion) {
      throw new ProjectTaskOrderConflictError();
    }
    if (input.expectedDestinationOrderVersion !== undefined && destinationVersion !== input.expectedDestinationOrderVersion) {
      throw new ProjectTaskOrderConflictError();
    }

    const current = await loadTaskByOwner(queryRunner, input.ownerId, input.taskId, true);
    if (!current) {
      throw new ProjectTaskNotFoundError();
    }
    if (current.projectId !== observed.projectId) {
      throw new ProjectTaskMoveConflictError();
    }
    if (current.status === 'archived') {
      throw new ProjectTaskArchivedError();
    }
    if (current.version !== input.expectedVersion) {
      throw new ProjectTaskVersionConflictError();
    }

    const destinationPosition = await countCollectionTasks(queryRunner, input.ownerId, input.destinationProjectId);
    const updated = asRows<{ readonly id: string }>(await queryRunner.query(
      `UPDATE "project_tasks" SET "project_id" = $1, "position" = $2, "version" = "version" + 1, "updated_at" = now()
       WHERE "owner_id" = $3 AND "id" = $4 AND "version" = $5 RETURNING "id"`,
      [input.destinationProjectId, destinationPosition, input.ownerId, input.taskId, input.expectedVersion]
    ));
    if (!updated[0]) {
      throw new ProjectTaskVersionConflictError();
    }
    await compactCollectionTaskPositions(queryRunner, input.ownerId, current.projectId, current.position);
    const sourceOrderVersion = await bumpCollectionOrderVersion(queryRunner, input.ownerId, current.projectId);
    const destinationOrderVersion = await bumpCollectionOrderVersion(queryRunner, input.ownerId, input.destinationProjectId);
    const task = await loadTaskByOwner(queryRunner, input.ownerId, input.taskId);
    if (!task) {
      throw new ProjectTaskNotFoundError();
    }
    await insertTaskMutationEvent(queryRunner, {
      ownerId: input.ownerId,
      projectId: current.projectId,
      taskId: task.id,
      actorKind: input.actorKind,
      eventType: 'task.updated',
      details: {
        fields: ['projectId', 'position'],
        fromCollection: current.projectId ?? 'inbox',
        toCollection: input.destinationProjectId ?? 'inbox'
      }
    });
    return makeTaskMutation({ task, before: current, sourceOrderVersion, destinationOrderVersion });
  }

  /** Archives a task without deleting its stable row, source provenance, checklist, or history. */
  public async archiveInTransaction(queryRunner: QueryRunner, input: ArchiveTaskMutationInput): Promise<AppliedTaskMutation> {
    const observed = await loadTaskByOwner(queryRunner, input.ownerId, input.taskId);
    if (!observed) {
      throw new ProjectTaskNotFoundError();
    }
    if (input.expectedProjectId !== undefined && observed.projectId !== input.expectedProjectId) {
      throw new ProjectTaskNotFoundError();
    }
    await lockCollectionProject(queryRunner, input.ownerId, observed.projectId);
    const orderVersion = await lockCollectionOrderState(queryRunner, input.ownerId, observed.projectId);
    if (input.expectedOrderVersion !== undefined && orderVersion !== input.expectedOrderVersion) {
      throw new ProjectTaskOrderConflictError();
    }
    const current = await loadTaskByOwner(queryRunner, input.ownerId, input.taskId, true);
    if (!current) {
      throw new ProjectTaskNotFoundError();
    }
    if (current.projectId !== observed.projectId) {
      throw new ProjectTaskMoveConflictError();
    }
    if (input.expectedProjectId !== undefined && current.projectId !== input.expectedProjectId) {
      throw new ProjectTaskNotFoundError();
    }
    if (current.status === 'archived') {
      throw new ProjectTaskArchivedError();
    }
    if (current.version !== input.expectedVersion) {
      throw new ProjectTaskVersionConflictError();
    }
    const updated = asRows<{ readonly id: string }>(await queryRunner.query(
      `UPDATE "project_tasks" SET "status" = 'archived', "archived_at" = now(), "version" = "version" + 1, "updated_at" = now()
       WHERE "owner_id" = $1 AND "id" = $2 AND "version" = $3 RETURNING "id"`,
      [input.ownerId, input.taskId, input.expectedVersion]
    ));
    if (!updated[0]) {
      throw new ProjectTaskVersionConflictError();
    }
    await compactCollectionTaskPositions(queryRunner, input.ownerId, current.projectId, current.position);
    const sourceOrderVersion = await bumpCollectionOrderVersion(queryRunner, input.ownerId, current.projectId);
    const task = await loadTaskByOwner(queryRunner, input.ownerId, input.taskId);
    if (!task) {
      throw new ProjectTaskNotFoundError();
    }
    await insertTaskMutationEvent(queryRunner, {
      ownerId: input.ownerId,
      projectId: current.projectId,
      taskId: task.id,
      actorKind: input.actorKind,
      eventType: 'task.status_changed',
      details: { from: current.status, to: 'archived' }
    });
    return makeTaskMutation({ task, before: current, sourceOrderVersion });
  }

  public async listTasks(ownerId: string, projectId: string, filter: ProjectTaskFilter): Promise<ProjectTaskListSnapshot> {
    return taskRowsForFilter(this.dataSource, ownerId, projectId, filter);
  }

  public async listGlobalTasks(input: {
    readonly ownerId: string;
    readonly filters: GlobalTaskQueryFilters;
    readonly after: GlobalTaskQueryCursorPosition | null;
  }): Promise<GlobalTaskQueryRepositoryPage> {
    const { filters, ownerId, after } = input;
    const rows = asRows<GlobalTaskQueryRow>(await this.dataSource.query(
      `SELECT ${TASK_COLUMNS}, p."id" AS "workspace_id", p."name" AS "workspace_name", p."status" AS "workspace_status",
              to_char(t."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursor_created_at"
       FROM "project_tasks" t
       LEFT JOIN "projects" p ON p."id" = t."project_id" AND p."owner_id" = t."owner_id"
       WHERE t."owner_id" = $1
         AND ($2::uuid IS NULL OR t."project_id" = $2)
         AND (NOT $3::boolean OR t."project_id" IS NULL)
         AND ($4::"project_task_status" IS NULL OR t."status" = $4)
         AND ($5::"project_task_importance" IS NULL OR t."importance" = $5)
         AND ($6::date IS NULL OR t."deadline" >= $6::date)
         AND ($7::date IS NULL OR t."deadline" <= $7::date)
         AND ($8::text IS NULL OR t."title" ILIKE $8 OR COALESCE(t."details", '') ILIKE $8)
         AND ($9::boolean OR (t."status" <> 'archived' AND (t."project_id" IS NULL OR p."status" <> 'archived')))
         AND ($10::timestamptz IS NULL OR (t."created_at", t."id") < ($10::timestamptz, $11::uuid))
       ORDER BY t."created_at" DESC, t."id" DESC
       LIMIT $12`,
      [
        ownerId,
        filters.workspaceId ?? null,
        filters.inboxOnly,
        filters.status ?? null,
        filters.importance ?? null,
        filters.deadlineFrom ?? null,
        filters.deadlineTo ?? null,
        filters.q ? `%${escapeLike(filters.q)}%` : null,
        filters.includeArchived,
        after?.createdAt ?? null,
        after?.taskId ?? null,
        filters.limit + 1
      ]
    ));
    const hasMore = rows.length > filters.limit;
    const visible = rows.slice(0, filters.limit);
    const lastRow = visible[visible.length - 1];
    return {
      items: visible.map(toGlobalTaskQueryItem),
      hasMore,
      lastPosition: hasMore && lastRow ? { createdAt: lastRow.cursor_created_at, taskId: lastRow.id } : null
    };
  }

  public async getGlobalTask(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly includeArchived: boolean;
  }): Promise<GlobalTaskQueryItem | null> {
    const rows = asRows<GlobalTaskQueryRow>(await this.dataSource.query(
      `SELECT ${TASK_COLUMNS}, p."id" AS "workspace_id", p."name" AS "workspace_name", p."status" AS "workspace_status",
              to_char(t."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursor_created_at"
       FROM "project_tasks" t
       LEFT JOIN "projects" p ON p."id" = t."project_id" AND p."owner_id" = t."owner_id"
       WHERE t."owner_id" = $1 AND t."id" = $2
         AND ($3::boolean OR (t."status" <> 'archived' AND (t."project_id" IS NULL OR p."status" <> 'archived')))
       LIMIT 1`,
      [input.ownerId, input.taskId, input.includeArchived]
    ));
    const row = rows[0];
    return row ? toGlobalTaskQueryItem(row) : null;
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
      const completion = resolveTaskChecklistState({
        current, ...(input.status ? { status: input.status } : {}),
        ...(input.text?.subtasks === undefined ? {} : { subtasks: input.text.subtasks })
      });
      if (input.status || completion.status !== current.status) {
        values.push(completion.status);
        setClauses.push(`"status" = $${values.length}`);
        setClauses.push(completion.status === 'done' ? '"completed_at" = COALESCE("completed_at", now())' : '"completed_at" = NULL');
      }
      if (input.status === 'done') {
        values.push(JSON.stringify(completion.subtasks));
        setClauses.push(`"subtasks" = $${values.length}::jsonb`);
      }
      if (input.text) {
        if (input.text.title !== undefined) {
          values.push(input.text.title);
          setClauses.push(`"title" = $${values.length}`);
        }
        if ('details' in input.text) {
          values.push(input.text.details ?? null);
          setClauses.push(`"details" = $${values.length}`);
        }
        for (const field of ['importance', 'deadline', 'subtasks'] as const) {
          if (field in input.text) {
            values.push(field === 'subtasks' ? JSON.stringify(completion.subtasks) : input.text[field]);
            setClauses.push(`"${field}" = $${values.length}${field === 'subtasks' ? '::jsonb' : ''}`);
          }
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
      if (completion.status !== current.status) {
        await insertTaskEvent(queryRunner, {
          ownerId: input.ownerId,
          projectId: input.projectId,
          taskId: task.id,
          eventType: 'task.status_changed',
          details: { from: current.status, to: completion.status }
        });
      }
      if (input.text) {
        await insertTaskEvent(queryRunner, {
          ownerId: input.ownerId,
          projectId: input.projectId,
          taskId: task.id,
          eventType: 'task.updated',
          details: { fields: Object.keys(input.text ?? {}) }
        });
      }
      return { task, orderVersion: await readOrderVersion(queryRunner, input.ownerId, input.projectId) };
    });
  }

  public async deleteTask(input: { readonly ownerId: string; readonly projectId: string; readonly taskId: string; readonly expectedVersion: number }): Promise<{ readonly orderVersion: number }> {
    return withTransaction(this.dataSource, async (queryRunner) => {
      await lockActiveProject(queryRunner, input.ownerId, input.projectId);
      await lockOrderState(queryRunner, input.ownerId, input.projectId);
      const current = await loadTask(queryRunner, input.ownerId, input.projectId, input.taskId, true);
      if (!current) throw new ProjectTaskNotFoundError();
      if (current.version !== input.expectedVersion) throw new ProjectTaskVersionConflictError();
      await queryRunner.query('DELETE FROM "project_tasks" WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3', [input.ownerId, input.projectId, input.taskId]);
      if (current.source.suggestionId) {
        await queryRunner.query('DELETE FROM "project_task_suggestions" WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3', [input.ownerId, input.projectId, current.source.suggestionId]);
      }
      if (current.status !== 'archived') await compactTaskPositions(queryRunner, input.ownerId, input.projectId, current.position);
      return { orderVersion: await bumpOrderVersion(queryRunner, input.ownerId, input.projectId) };
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
      `SELECT s."id", s."owner_id", s."project_id", s."run_id", s."conversation_id", s."title", s."details", s."subtasks", s."status", s."version", s."created_at", s."resolved_at",
              (SELECT t."id" FROM "project_tasks" t
               WHERE t."owner_id" = s."owner_id" AND t."source_suggestion_project_id" = s."project_id" AND t."source_suggestion_id" = s."id" LIMIT 1) AS "task_id"
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
        importance: input.importance ?? 'medium',
        deadline: input.deadline ?? null,
        subtasks: input.subtasks ?? normalizeTaskSubtasks(current.subtasks),
        sourceSuggestion: {
          id: current.id,
          projectId: current.projectId,
          runId: current.runId,
          conversationId: current.conversationId
        }
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
