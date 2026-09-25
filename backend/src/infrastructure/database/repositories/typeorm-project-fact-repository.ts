import type { DataSource } from 'typeorm';

import { ProjectFactAlreadyExistsError } from '@/modules/memory/domain/project-fact-errors';
import { projectFactVerificationStatus, type ProjectFact } from '@/modules/memory/domain/project-fact';
import type { CreateProjectFactRecord, IProjectFactRepository, ProjectFactVersionRecord, UpdateProjectFactRecord } from '@/modules/memory/repositories/project-fact-repository';

interface ProjectFactRow {
  readonly id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly fact_key: string;
  readonly title: string;
  readonly content: string;
  readonly version: number;
  readonly verified_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function toDate(value: Date | number | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('The project fact repository returned an invalid timestamp.');
  }
  return date;
}

function toProjectFact(row: ProjectFactRow): ProjectFact {
  const updatedAt = toDate(row.updated_at);
  const verifiedAt = row.verified_at === null ? null : toDate(row.verified_at);
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    key: row.fact_key,
    title: row.title,
    content: row.content,
    source: { kind: 'user', label: 'Added by you', reference: null },
    version: row.version,
    verifiedAt,
    verificationStatus: projectFactVerificationStatus(verifiedAt),
    createdAt: toDate(row.created_at),
    updatedAt
  };
}

function returnedRows<T>(result: unknown): readonly T[] {
  if (!Array.isArray(result)) {
    throw new Error('The project fact repository returned an unexpected query result.');
  }
  // TypeORM's PostgreSQL DataSource.query returns [rows, rowCount] for UPDATE/DELETE by default.
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as readonly T[];
  }
  return result as readonly T[];
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export class TypeOrmProjectFactRepository implements IProjectFactRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async listActiveByProject(ownerId: string, projectId: string): Promise<readonly ProjectFact[]> {
    const rows: readonly ProjectFactRow[] = await this.dataSource.query(
      `${this.selectColumns()} WHERE "owner_id" = $1 AND "project_id" = $2 AND "deleted_at" IS NULL ORDER BY "updated_at" DESC, "id" ASC`,
      [ownerId, projectId]
    );
    return rows.map((row) => toProjectFact(row));
  }

  public async findActiveById(ownerId: string, projectId: string, factId: string): Promise<ProjectFact | null> {
    const rows: readonly ProjectFactRow[] = await this.dataSource.query(
      `${this.selectColumns()} WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3 AND "deleted_at" IS NULL LIMIT 1`,
      [ownerId, projectId, factId]
    );
    return rows[0] ? toProjectFact(rows[0]) : null;
  }

  public async findActiveByIds(ownerId: string, projectId: string, factIds: readonly string[]): Promise<readonly ProjectFact[]> {
    if (factIds.length === 0) {
      return [];
    }
    const rows: readonly ProjectFactRow[] = await this.dataSource.query(
      `${this.selectColumns()} WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = ANY($3::uuid[]) AND "deleted_at" IS NULL`,
      [ownerId, projectId, factIds]
    );
    return rows.map((row) => toProjectFact(row));
  }

  public async create(input: CreateProjectFactRecord): Promise<ProjectFact> {
    try {
      const rows: readonly ProjectFactRow[] = await this.dataSource.query(
        `INSERT INTO "project_facts" ("owner_id", "project_id", "fact_key", "title", "content")
         VALUES ($1, $2, $3, $4, $5)
         RETURNING "id", "owner_id", "project_id", "fact_key", "title", "content", "version", "verified_at", "created_at", "updated_at"`,
        [input.ownerId, input.projectId, input.key, input.title, input.content]
      );
      const row = rows[0];
      if (!row) {
        throw new Error('The project fact could not be created.');
      }
      return toProjectFact(row);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ProjectFactAlreadyExistsError();
      }
      throw error;
    }
  }

  public async update(input: UpdateProjectFactRecord): Promise<ProjectFact | null> {
    const result: unknown = await this.dataSource.query(
      `UPDATE "project_facts" SET "fact_key" = $1, "title" = $2, "content" = $3, "version" = "version" + 1, "verified_at" = NULL, "updated_at" = now()
       WHERE "owner_id" = $4 AND "project_id" = $5 AND "id" = $6 AND "version" = $7 AND "deleted_at" IS NULL
       RETURNING "id", "owner_id", "project_id", "fact_key", "title", "content", "version", "verified_at", "created_at", "updated_at"`,
      [input.key, input.title, input.content, input.ownerId, input.projectId, input.factId, input.expectedVersion]
    );
    const rows = returnedRows<ProjectFactRow>(result);
    return rows[0] ? toProjectFact(rows[0]) : null;
  }

  public async verify(input: ProjectFactVersionRecord): Promise<ProjectFact | null> {
    const result: unknown = await this.dataSource.query(
      `UPDATE "project_facts" SET "verified_at" = now(), "version" = "version" + 1, "updated_at" = now()
       WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3 AND "version" = $4 AND "deleted_at" IS NULL
       RETURNING "id", "owner_id", "project_id", "fact_key", "title", "content", "version", "verified_at", "created_at", "updated_at"`,
      [input.ownerId, input.projectId, input.factId, input.expectedVersion]
    );
    const rows = returnedRows<ProjectFactRow>(result);
    return rows[0] ? toProjectFact(rows[0]) : null;
  }

  public async softDelete(input: ProjectFactVersionRecord): Promise<boolean> {
    const result: unknown = await this.dataSource.query(
      `UPDATE "project_facts" SET "deleted_at" = now(), "version" = "version" + 1, "updated_at" = now()
       WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3 AND "version" = $4 AND "deleted_at" IS NULL
       RETURNING "id"`,
      [input.ownerId, input.projectId, input.factId, input.expectedVersion]
    );
    const rows = returnedRows<{ readonly id: string }>(result);
    return Boolean(rows[0]);
  }

  private selectColumns(): string {
    return 'SELECT "id", "owner_id", "project_id", "fact_key", "title", "content", "version", "verified_at", "created_at", "updated_at" FROM "project_facts"';
  }
}
