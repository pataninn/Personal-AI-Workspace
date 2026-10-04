import type { DataSource, QueryRunner } from 'typeorm';

import { normalizeTaskSuggestionDrafts } from '@/modules/tasks/domain/project-task-validation';
import type { ProjectTaskSuggestion, TaskSuggestionDraft } from '@/modules/tasks/domain/project-task';
import type { IProjectTaskSuggestionQuery } from '@/modules/tasks/repositories/task-suggestion-query';

export interface TaskSuggestionRunContext {
  readonly runId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly conversationId: string;
}

/**
 * A transaction participant for the existing AI-run completion transaction.
 * Implementations must use the supplied QueryRunner and must never manage its
 * connection or transaction lifecycle.
 */
export interface TaskSuggestionCompletionWriter {
  persistForRunCompletion(
    queryRunner: QueryRunner,
    runContext: TaskSuggestionRunContext,
    drafts: readonly TaskSuggestionDraft[]
  ): Promise<void>;
}

/**
 * Inserts validated assistant suggestions and proposal events in the caller's
 * active run-completion transaction. Unique run/ordinal and event fences make
 * retrying the same database write safe after an ambiguous commit result.
 */
export class TypeOrmTaskSuggestionRepository implements TaskSuggestionCompletionWriter, IProjectTaskSuggestionQuery {
  public constructor(private readonly dataSource: DataSource) {}

  public async persistForRunCompletion(
    queryRunner: QueryRunner,
    runContext: TaskSuggestionRunContext,
    drafts: readonly TaskSuggestionDraft[]
  ): Promise<void> {
    const normalizedDrafts = normalizeTaskSuggestionDrafts(drafts);
    for (const [ordinal, draft] of normalizedDrafts.entries()) {
      const rows = asRows<SuggestionWriteRow>(await queryRunner.query(
        `INSERT INTO "project_task_suggestions" ("owner_id", "project_id", "run_id", "conversation_id", "ordinal", "title", "details", "subtasks")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT ("run_id", "ordinal") DO NOTHING
         RETURNING "id", "owner_id", "project_id", "conversation_id", "title", "details", "subtasks", "status"`,
        [runContext.ownerId, runContext.projectId, runContext.runId, runContext.conversationId, ordinal, draft.title, draft.details ?? null, JSON.stringify(draft.subtasks ?? [])]
      ));
      let suggestion = rows[0];
      if (!suggestion) {
        const existing = asRows<SuggestionWriteRow>(await queryRunner.query(
          `SELECT "id", "owner_id", "project_id", "conversation_id", "title", "details", "subtasks", "status"
           FROM "project_task_suggestions" WHERE "run_id" = $1 AND "ordinal" = $2 LIMIT 1`,
          [runContext.runId, ordinal]
        ));
        suggestion = existing[0];
      }
      if (!suggestion || !matchesSuggestion(suggestion, runContext, draft)) {
        throw new Error('The task suggestion completion write did not match its run context.');
      }
      await queryRunner.query(
        `INSERT INTO "project_task_events" ("owner_id", "project_id", "suggestion_id", "run_id", "actor_kind", "event_type", "details")
         VALUES ($1, $2, $3, $4, 'assistant', 'task.suggestion_proposed', jsonb_build_object('ordinal', $5::integer))
         ON CONFLICT ("suggestion_id", "event_type") WHERE "suggestion_id" IS NOT NULL AND "event_type" = 'task.suggestion_proposed' DO NOTHING`,
        [runContext.ownerId, runContext.projectId, suggestion.id, runContext.runId, ordinal]
      );
    }
  }

  public async listForRun(ownerId: string, projectId: string, runId: string): Promise<readonly ProjectTaskSuggestion[]> {
    const rows = await this.dataSource.query(
      `SELECT "id", "project_id", "run_id", "conversation_id", "title", "details", "subtasks", "status", "version", "created_at", "resolved_at",
              (SELECT "id" FROM "project_tasks" WHERE "source_suggestion_id" = "project_task_suggestions"."id" LIMIT 1) AS "task_id"
       FROM "project_task_suggestions"
       WHERE "owner_id" = $1 AND "project_id" = $2 AND "run_id" = $3
       ORDER BY "ordinal" ASC, "id" ASC`,
      [ownerId, projectId, runId]
    ) as readonly SuggestionListRow[];
    return rows.map(toProjectTaskSuggestion);
  }
}

interface SuggestionWriteRow {
  readonly id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly conversation_id: string;
  readonly title: string;
  readonly details: string | null;
  readonly subtasks: ProjectTaskSuggestion['subtasks'];
  readonly status: string;
}

function asRows<T>(result: unknown): readonly T[] {
  if (!Array.isArray(result)) {
    throw new Error('The task suggestion repository returned an unexpected query result.');
  }
  return result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number'
    ? result[0] as readonly T[]
    : result as readonly T[];
}

interface SuggestionListRow {
  readonly id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly conversation_id: string;
  readonly title: string;
  readonly details: string | null;
  readonly subtasks: ProjectTaskSuggestion['subtasks'];
  readonly status: ProjectTaskSuggestion['status'];
  readonly version: number;
  readonly created_at: Date | string;
  readonly resolved_at: Date | string | null;
  readonly task_id: string | null;
}

function toProjectTaskSuggestion(row: SuggestionListRow): ProjectTaskSuggestion {
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
    resolvedAt: row.resolved_at === null ? null : toDate(row.resolved_at)
  };
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('The project task suggestion repository returned an invalid timestamp.');
  }
  return date;
}

function matchesSuggestion(row: SuggestionWriteRow, context: TaskSuggestionRunContext, draft: TaskSuggestionDraft): boolean {
  return row.owner_id === context.ownerId
    && row.project_id === context.projectId
    && row.conversation_id === context.conversationId
    && row.title === draft.title
    && row.details === (draft.details ?? null)
    && JSON.stringify(row.subtasks ?? []) === JSON.stringify(draft.subtasks ?? [])
    && row.status === 'pending';
}
