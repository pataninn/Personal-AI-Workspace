import type { DataSource } from 'typeorm';

import type { ProjectStatus } from '@/modules/projects/domain/project-types';
import type { ActiveProjectSummary, HomeTaskSummary, IProjectOverviewRepository, ProjectOverview } from '@/modules/projects/repositories/project-overview-repository';

interface ProjectActivityRow {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly slug: string;
  readonly relative_root: string | null;
  readonly objective: string | null;
  readonly status: ProjectStatus;
  readonly version: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly last_activity_at: Date | string;
}

function toSummary(row: ProjectActivityRow): ActiveProjectSummary {
  return {
    id: row.id, ownerId: row.owner_id, name: row.name, slug: row.slug,
    relativeRoot: row.relative_root, objective: row.objective, status: row.status, version: row.version,
    createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
    lastActivityAt: new Date(row.last_activity_at)
  };
}

/** Queries project activity without loading chat or file contents. */
export class TypeOrmProjectOverviewRepository implements IProjectOverviewRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async getOverview(ownerId: string, taskLimit: number): Promise<ProjectOverview> {
    const [projects, tasks] = await Promise.all([this.listProjects(ownerId), this.listTasks(ownerId, taskLimit)]);
    return { projects, tasks };
  }

  private async listProjects(ownerId: string): Promise<readonly ActiveProjectSummary[]> {
    const rows: readonly ProjectActivityRow[] = await this.dataSource.query(`
      SELECT p.*, GREATEST(p."updated_at", c.activity, t.activity, f.activity) AS "last_activity_at"
      FROM "projects" p
      LEFT JOIN LATERAL (SELECT MAX("last_activity_at") AS activity FROM "conversations"
        WHERE "owner_id" = p."owner_id" AND "project_id" = p."id") c ON true
      LEFT JOIN LATERAL (SELECT MAX("updated_at") AS activity FROM "project_tasks"
        WHERE "owner_id" = p."owner_id" AND "project_id" = p."id") t ON true
      LEFT JOIN LATERAL (SELECT MAX("updated_at") AS activity FROM "ai_run_change_sets"
        WHERE "owner_id" = p."owner_id" AND "project_id" = p."id" AND "status" = 'applied') f ON true
      WHERE p."owner_id" = $1 AND p."status" = 'active'
      ORDER BY "last_activity_at" DESC, p."id" ASC`, [ownerId]);
    return rows.map(toSummary);
  }

  private async listTasks(ownerId: string, taskLimit: number): Promise<readonly HomeTaskSummary[]> {
    return this.dataSource.query(`
      SELECT t."id", t."project_id" AS "projectId", p."name" AS "projectName", t."title",
        t."status", t."importance", to_char(t."deadline", 'YYYY-MM-DD') AS "deadline", t."version"
      FROM "project_tasks" t JOIN "projects" p ON p."id" = t."project_id" AND p."owner_id" = t."owner_id"
      WHERE t."owner_id" = $1 AND p."status" = 'active' AND t."status" IN ('todo', 'in_progress', 'blocked')
      ORDER BY t."deadline" ASC NULLS LAST, t."importance" DESC, t."updated_at" DESC, t."id" ASC LIMIT $2`,
    [ownerId, taskLimit]);
  }
}
