import type { DataSource } from 'typeorm';

import { DEFAULT_PROJECT_CHAT_CONTEXT, type IProjectChatContextRepository, type ProjectChatContext } from '@/modules/ai-runs/repositories/project-chat-context-repository';

export class TypeOrmProjectChatContextRepository implements IProjectChatContextRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async get(ownerId: string, projectId: string): Promise<ProjectChatContext> {
    const rows: readonly ProjectChatContext[] = await this.dataSource.query(
      `SELECT "relative_paths" AS "relativePaths", "fact_ids" AS "factIds", "include_project_conversations" AS "includeProjectConversations", "excluded_paths" AS "excludedPaths"
       FROM "project_chat_context" WHERE "owner_id" = $1 AND "project_id" = $2`, [ownerId, projectId]
    );
    return rows[0] ?? DEFAULT_PROJECT_CHAT_CONTEXT;
  }

  public async update(ownerId: string, projectId: string, changes: Partial<ProjectChatContext>): Promise<ProjectChatContext> {
    const rows: readonly ProjectChatContext[] = await this.dataSource.query(
      `INSERT INTO "project_chat_context" ("owner_id", "project_id", "relative_paths", "fact_ids", "include_project_conversations", "excluded_paths")
       VALUES ($1, $2, COALESCE($3::jsonb, '[]'::jsonb), COALESCE($4::jsonb, '[]'::jsonb), COALESCE($5::boolean, true), COALESCE($6::jsonb, '[]'::jsonb))
       ON CONFLICT ("project_id") DO UPDATE SET
         "relative_paths" = COALESCE($3::jsonb, "project_chat_context"."relative_paths"),
         "fact_ids" = COALESCE($4::jsonb, "project_chat_context"."fact_ids"),
         "excluded_paths" = COALESCE($6::jsonb, "project_chat_context"."excluded_paths"),
         "include_project_conversations" = COALESCE($5::boolean, "project_chat_context"."include_project_conversations"), "updated_at" = now()
       WHERE "project_chat_context"."owner_id" = $1
       RETURNING "relative_paths" AS "relativePaths", "fact_ids" AS "factIds", "include_project_conversations" AS "includeProjectConversations", "excluded_paths" AS "excludedPaths"`,
      [ownerId, projectId, changes.relativePaths === undefined ? null : JSON.stringify(changes.relativePaths),
        changes.factIds === undefined ? null : JSON.stringify(changes.factIds), changes.includeProjectConversations ?? null,
        changes.excludedPaths === undefined ? null : JSON.stringify(changes.excludedPaths)]
    );
    if (!rows[0]) throw new Error('The project context could not be saved.');
    return rows[0];
  }
}
