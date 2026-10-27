import type { DataSource, QueryRunner } from 'typeorm';

import { lockProjectWriteState } from '@/infrastructure/database/project-removal-write-barrier';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { fixedContentScope, resultContentScope } from '@/infrastructure/database/storage-content-projections';
import { ProjectFactAlreadyExistsError, ProjectFactArchivedProjectError } from '@/modules/memory/domain/project-fact-errors';
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
  private readonly storageAccounting: Pick<TypeOrmStorageContentAccounting, 'runMutation'>;

  public constructor(
    private readonly dataSource: DataSource,
    storageAccounting?: Pick<TypeOrmStorageContentAccounting, 'runMutation'>
  ) {
    this.storageAccounting = storageAccounting ?? new TypeOrmStorageContentAccounting(dataSource);
  }

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
      return await this.withAccountedMutation(input.ownerId, input.projectId, async (queryRunner) => {
        const result: unknown = await queryRunner.query(
          `INSERT INTO "project_facts" ("owner_id", "project_id", "fact_key", "title", "content")
           VALUES ($1, $2, $3, $4, $5)
           RETURNING "id", "owner_id", "project_id", "fact_key", "title", "content", "version", "verified_at", "created_at", "updated_at"`,
          [input.ownerId, input.projectId, input.key, input.title, input.content]
        );
        const row = returnedRows<ProjectFactRow>(result)[0];
        if (!row) {
          throw new Error('The project fact could not be created.');
        }
        return toProjectFact(row);
      }, resultContentScope((fact: ProjectFact) => [{ entity: 'project_facts', id: fact.id }]));
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ProjectFactAlreadyExistsError();
      }
      throw error;
    }
  }

  public async update(input: UpdateProjectFactRecord): Promise<ProjectFact | null> {
    return await this.withAccountedMutation(input.ownerId, input.projectId, async (queryRunner) => {
      const result: unknown = await queryRunner.query(
        `UPDATE "project_facts" SET "fact_key" = $1, "title" = $2, "content" = $3, "version" = "version" + 1, "verified_at" = NULL, "updated_at" = now()
         WHERE "owner_id" = $4 AND "project_id" = $5 AND "id" = $6 AND "version" = $7 AND "deleted_at" IS NULL
         RETURNING "id", "owner_id", "project_id", "fact_key", "title", "content", "version", "verified_at", "created_at", "updated_at"`,
        [input.key, input.title, input.content, input.ownerId, input.projectId, input.factId, input.expectedVersion]
      );
      const rows = returnedRows<ProjectFactRow>(result);
      return rows[0] ? toProjectFact(rows[0]) : null;
    }, fixedContentScope([{ entity: 'project_facts', id: input.factId }]));
  }

  public async verify(input: ProjectFactVersionRecord): Promise<ProjectFact | null> {
    return await this.withProjectMutation(input.ownerId, input.projectId, async (queryRunner) => {
      const result: unknown = await queryRunner.query(
        `UPDATE "project_facts" SET "verified_at" = now(), "version" = "version" + 1, "updated_at" = now()
         WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3 AND "version" = $4 AND "deleted_at" IS NULL
         RETURNING "id", "owner_id", "project_id", "fact_key", "title", "content", "version", "verified_at", "created_at", "updated_at"`,
        [input.ownerId, input.projectId, input.factId, input.expectedVersion]
      );
      const rows = returnedRows<ProjectFactRow>(result);
      return rows[0] ? toProjectFact(rows[0]) : null;
    });
  }

  public async softDelete(input: ProjectFactVersionRecord): Promise<boolean> {
    return await this.withProjectMutation(input.ownerId, input.projectId, async (queryRunner) => {
      const result: unknown = await queryRunner.query(
        `UPDATE "project_facts" SET "deleted_at" = now(), "version" = "version" + 1, "updated_at" = now()
         WHERE "owner_id" = $1 AND "project_id" = $2 AND "id" = $3 AND "version" = $4 AND "deleted_at" IS NULL
         RETURNING "id"`,
        [input.ownerId, input.projectId, input.factId, input.expectedVersion]
      );
      return Boolean(returnedRows<{ readonly id: string }>(result)[0]);
    });
  }

  private async withAccountedMutation<T>(
    ownerId: string,
    projectId: string,
    mutation: (queryRunner: QueryRunner) => Promise<T>,
    scope: import('@/infrastructure/database/storage-content-projections').StorageContentMutationScope<T>
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    try {
      await queryRunner.connect();
      connected = true;
      return await this.runAccountedTransaction(queryRunner, ownerId, async (transaction) => {
        await this.assertWritableProject(transaction, ownerId, projectId);
        return mutation(transaction);
      }, scope);
    } finally {
      if (connected) {
        await queryRunner.release();
      }
    }
  }

  private async runAccountedTransaction<T>(
    queryRunner: QueryRunner,
    ownerId: string,
    mutation: (queryRunner: QueryRunner) => Promise<T>,
    scope: import('@/infrastructure/database/storage-content-projections').StorageContentMutationScope<T>
  ): Promise<T> {
    try {
      await queryRunner.startTransaction();
      const result = await this.storageAccounting.runMutation(queryRunner, ownerId, () => mutation(queryRunner), scope);
      await queryRunner.commitTransaction();
      return result;
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    }
  }

  private selectColumns(): string {
    return 'SELECT "id", "owner_id", "project_id", "fact_key", "title", "content", "version", "verified_at", "created_at", "updated_at" FROM "project_facts"';
  }

  private async withProjectMutation<T>(ownerId: string, projectId: string, mutation: (queryRunner: QueryRunner) => Promise<T>): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    let connected = false;
    try {
      await queryRunner.connect();
      connected = true;
      await queryRunner.startTransaction();
      await this.assertWritableProject(queryRunner, ownerId, projectId);
      const result = await mutation(queryRunner);
      await queryRunner.commitTransaction();
      return result;
    } catch (error: unknown) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      if (connected) await queryRunner.release();
    }
  }

  private async assertWritableProject(queryRunner: QueryRunner, ownerId: string, projectId: string): Promise<void> {
    const project = await lockProjectWriteState(queryRunner, ownerId, projectId);
    if (!project || project.status !== 'active' || project.removalPending) throw new ProjectFactArchivedProjectError();
  }
}
