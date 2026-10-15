import type { DataSource, QueryRunner } from 'typeorm';

import { ProjectNameConflictError, ProjectRootOverlapError } from '@/modules/projects/domain/project-errors';
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
  AttachProjectRootRecord
} from '@/modules/projects/repositories/project-workspace-repository';

interface ProjectRow {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly slug: string;
  readonly relative_root: string | null;
  readonly relative_root_key: string | null;
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

async function lockOwner(queryRunner: QueryRunner, ownerId: string): Promise<void> {
  await queryRunner.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`projects:${ownerId}`]);
}

async function findActiveRoots(queryRunner: QueryRunner, ownerId: string): Promise<readonly string[]> {
  const rows: readonly { relative_root: string }[] = await queryRunner.query(
    'SELECT "relative_root_key" AS "relative_root" FROM "projects" WHERE "owner_id" = $1 AND "status" = \'active\' AND "relative_root_key" IS NOT NULL',
    [ownerId]
  );
  return rows.map((row) => row.relative_root);
}

export class TypeOrmProjectRepository implements IProjectRepository, IProjectWorkspaceRepository<QueryRunner> {
  public constructor(private readonly dataSource: DataSource) {}

  public async listByOwner(ownerId: string, includeArchived: boolean): Promise<readonly Project[]> {
    const statusFilter = includeArchived ? '' : ' AND "status" = \'active\'';
    const rows: readonly ProjectRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "objective", "status", "version", "created_at", "updated_at"
       FROM "projects" WHERE "owner_id" = $1${statusFilter} ORDER BY CASE WHEN "status" = 'active' THEN 0 ELSE 1 END, "name" ASC, "created_at" ASC`,
      [ownerId]
    );
    return rows.map(toProject);
  }

  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> {
    const rows: readonly ProjectRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "objective", "status", "version", "created_at", "updated_at"
       FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1`,
      [ownerId, projectId]
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  public async listActiveRoots(ownerId: string): Promise<readonly string[]> {
    const rows: readonly { relative_root: string }[] = await this.dataSource.query(
      'SELECT "relative_root_key" AS "relative_root" FROM "projects" WHERE "owner_id" = $1 AND "status" = \'active\' AND "relative_root_key" IS NOT NULL',
      [ownerId]
    );
    return rows.map((row) => row.relative_root);
  }

  public async searchForOwner(ownerId: string, query: string, limit: number): Promise<ProjectMetadataSearchResult> {
    const rows: readonly ProjectRow[] = await this.dataSource.query(
      `SELECT "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "objective", "status", "version", "created_at", "updated_at"
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
      `SELECT "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "objective", "status", "version", "created_at", "updated_at"
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
        `INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "objective")
         VALUES ($1, $2, $3, $4, NULL, NULL, $5)
         RETURNING "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "objective", "status", "version", "created_at", "updated_at"`,
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
    const [rows]: readonly [readonly ProjectRow[], number] = await transaction.query(
      `UPDATE "projects" SET "objective" = $1, "version" = "version" + 1, "updated_at" = now()
       WHERE "owner_id" = $2 AND "id" = $3 AND "version" = $4
       RETURNING "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "objective", "status", "version", "created_at", "updated_at"`,
      [input.objective, input.ownerId, input.projectId, input.expectedVersion]
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  public async attachInitialRoot(transaction: QueryRunner, input: AttachProjectRootRecord): Promise<Project | null> {
    try {
      const [rows]: readonly [readonly ProjectRow[], number] = await transaction.query(
        `UPDATE "projects" SET "relative_root" = $1, "relative_root_key" = $2, "version" = "version" + 1, "updated_at" = now()
         WHERE "owner_id" = $3 AND "id" = $4 AND "version" = $5 AND "relative_root" IS NULL
         RETURNING "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "objective", "status", "version", "created_at", "updated_at"`,
        [input.relativeRoot, input.relativeRootKey, input.ownerId, input.projectId, input.expectedVersion]
      );
      return rows[0] ? toProject(rows[0]) : null;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new ProjectRootOverlapError();
      throw error;
    }
  }

  public async create(input: CreateProjectRecord): Promise<Project> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await lockOwner(queryRunner, input.ownerId);
      const roots = await findActiveRoots(queryRunner, input.ownerId);
      const relativeRoot = input.relativeRoot;
      if (relativeRoot !== null && roots.some((root) => projectRootsOverlap(relativeRoot, root))) {
        throw new ProjectRootOverlapError();
      }
      const rows: readonly ProjectRow[] = await queryRunner.query(
        `INSERT INTO "projects" ("owner_id", "name", "slug", "relative_root", "relative_root_key", "objective")
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "objective", "status", "version", "created_at", "updated_at"`,
        [input.ownerId, input.name, input.slug, input.relativeRoot, input.relativeRoot === null ? null : input.relativeRootKey ?? projectRootOverlapKey(input.relativeRoot), input.objective]
      );
      const row = rows[0];
      if (!row) {
        throw new Error('The project could not be created.');
      }
      await queryRunner.commitTransaction();
      return toProject(row);
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
      if (input.status === 'active') {
        const current = await queryRunner.query(
          'SELECT "relative_root_key" AS "relative_root" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1',
          [input.ownerId, input.projectId]
        ) as readonly { relative_root: string | null }[];
        const roots = await queryRunner.query(
          'SELECT "relative_root_key" AS "relative_root" FROM "projects" WHERE "owner_id" = $1 AND "status" = \'active\' AND "id" <> $2 AND "relative_root_key" IS NOT NULL',
          [input.ownerId, input.projectId]
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
         RETURNING "id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "objective", "status", "version", "created_at", "updated_at"`,
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
