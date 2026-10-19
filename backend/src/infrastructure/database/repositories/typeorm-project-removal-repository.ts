import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmStorageQuotaRepository, lockStorageRootOwner } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import type { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import type { StorageContentEntity, StorageContentIdentity, StorageContentMutationScope } from '@/infrastructure/database/storage-content-projections';
import type { IStorageRootMappingRepository } from '@/modules/storage-quotas/repositories/storage-root-mapping-repository';
import type { StorageQuotaTransaction } from '@/modules/storage-quotas/repositories/storage-quota-repository';
import { accountingUnavailable } from '@/modules/storage-quotas/domain/storage-quota-errors';
import { ProjectNotFoundError, ProjectRecoveryCleanupError, ProjectRemovalBusyError, ProjectRemovalCleanupPendingError, ProjectVersionConflictError } from '@/modules/projects/domain/project-errors';
import type { IProjectRecoveryCleaner, IProjectRecoveryQuarantine, IProjectRemovalRepository, RemoveProjectRecord } from '@/modules/projects/repositories/project-removal-repository';

interface RunState {
  readonly id: string;
  readonly status: string;
  readonly cleanup: string;
}

interface ProjectRow {
  readonly id: string;
  readonly version: number;
  readonly relative_root_key: string | null;
}

interface RemovalJob {
  readonly owner_id: string;
  readonly project_id: string;
  readonly storage_root_key: string | null;
  readonly run_ids: unknown;
}

interface RemovalPlan {
  readonly ownerId: string;
  readonly projectId: string;
  readonly rootKey: string | null;
  readonly runIds: readonly string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function queryRows<T>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) throw accountingUnavailable();
  if (value.length === 2 && Array.isArray(value[0]) && typeof value[1] === 'number') return value[0] as readonly T[];
  return value as readonly T[];
}

function parseRunIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string' && UUID_PATTERN.test(item))
    || new Set(value).size !== value.length) throw new ProjectRecoveryCleanupError();
  return value;
}

function isLockConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error.code === '55P03' || error.code === '40P01');
}

async function lockProject(runner: StorageQuotaTransaction, input: RemoveProjectRecord): Promise<ProjectRow> {
  const rows = queryRows<ProjectRow>(await runner.query(
    'SELECT "id", "version", "relative_root_key" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 FOR UPDATE NOWAIT',
    [input.ownerId, input.projectId]
  ));
  const project = rows[0];
  if (!project) throw new ProjectNotFoundError();
  if (project.version !== input.expectedVersion) throw new ProjectVersionConflictError();
  return project;
}

async function lockRuns(runner: StorageQuotaTransaction, input: RemoveProjectRecord): Promise<readonly string[]> {
  const rows = queryRows<RunState>(await runner.query(
    'SELECT "id", "status", "cleanup" FROM "ai_runs" WHERE "owner_id" = $1 AND "project_id" = $2 ORDER BY "id" FOR UPDATE NOWAIT',
    [input.ownerId, input.projectId]
  ));
  const terminal = ['succeeded', 'failed', 'blocked', 'cancelled', 'rejected'];
  if (rows.some((row) => !terminal.includes(row.status) || row.cleanup === 'unknown')) throw new ProjectRemovalBusyError();
  return rows.map((row) => row.id);
}

async function lockDependents(runner: StorageQuotaTransaction, input: RemoveProjectRecord): Promise<void> {
  const parameters = [input.ownerId, input.projectId];
  const changes = queryRows<{ readonly status: string }>(await runner.query(
    'SELECT "status" FROM "ai_run_change_sets" WHERE "owner_id" = $1 AND "project_id" = $2 ORDER BY "id" FOR UPDATE NOWAIT', parameters));
  const commands = queryRows<{ readonly status: string }>(await runner.query(
    'SELECT "status" FROM "sandbox_commands" WHERE "owner_id" = $1 AND "project_id" = $2 ORDER BY "id" FOR UPDATE NOWAIT', parameters));
  if (changes.some((row) => ['awaiting_approval', 'applying', 'needs_manual_review'].includes(row.status))
    || commands.some((row) => ['awaiting_approval', 'running', 'cancel_requested', 'review_required'].includes(row.status))) {
    throw new ProjectRemovalBusyError();
  }
}

async function lockRootAndReservations(
  transaction: StorageQuotaTransaction,
  input: { readonly ownerId: string; readonly projectId: string }
): Promise<string | null> {
  await lockStorageRootOwner(transaction, input.ownerId);
  const projects = queryRows<{ readonly relative_root_key: string | null }>(await transaction.query(
    'SELECT "relative_root_key" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2', [input.ownerId, input.projectId]
  ));
  const projectRootKey = projects[0]?.relative_root_key ?? null;
  const mappings = queryRows<{ readonly root_key: string }>(await transaction.query(
    `SELECT "root_key" FROM "storage_root_mappings"
     WHERE "owner_id" = $1 AND "project_id" = $2 AND "state" = 'active' FOR UPDATE`,
    [input.ownerId, input.projectId]
  ));
  if ((projectRootKey === null && mappings.length !== 0)
    || (projectRootKey !== null && (mappings.length !== 1 || mappings[0]?.root_key !== projectRootKey))) {
    throw accountingUnavailable();
  }
  const rootKey = mappings[0]?.root_key ?? null;
  const pending = queryRows<{ readonly id: string }>(await transaction.query(
    `SELECT "id" FROM "storage_filesystem_reservations"
     WHERE "owner_id" = $1 AND "project_id" = $2 AND "status" IN ('pending', 'unknown')
     ORDER BY "id" FOR UPDATE`,
    [input.ownerId, input.projectId]
  ));
  if (pending.length > 0) throw new ProjectRemovalBusyError();
  return rootKey;
}

async function selectIds(
  transaction: StorageQuotaTransaction,
  entity: StorageContentEntity,
  sql: string,
  ownerId: string,
  projectId: string
): Promise<readonly StorageContentIdentity[]> {
  const rows = queryRows<{ readonly id: string }>(await transaction.query(sql, [ownerId, projectId]));
  return rows.map((row) => ({ entity, id: row.id }));
}

async function selectProjectHomeContentIdentities(
  transaction: StorageQuotaTransaction,
  input: { readonly ownerId: string; readonly projectId: string }
): Promise<readonly StorageContentIdentity[]> {
  const identities: StorageContentIdentity[] = [
    ...await selectIds(transaction, 'home_conversations',
      `SELECT "id" FROM "home_conversations" WHERE "owner_id" = $1 AND "scope" = 'workspace' AND "workspace_id" = $2`,
      input.ownerId, input.projectId),
    ...await selectIds(transaction, 'home_messages',
      `SELECT m."id" FROM "home_messages" m JOIN "home_conversations" h ON h."owner_id" = m."owner_id" AND h."id" = m."conversation_id"
       WHERE m."owner_id" = $1 AND h."scope" = 'workspace' AND h."workspace_id" = $2`, input.ownerId, input.projectId),
    ...await selectIds(transaction, 'home_change_proposal_items',
      `SELECT i."id" FROM "home_change_proposal_items" i
       JOIN "home_change_proposals" p ON p."owner_id" = i."owner_id" AND p."conversation_id" = i."conversation_id" AND p."id" = i."proposal_id"
       LEFT JOIN "home_conversations" h ON h."owner_id" = p."owner_id" AND h."id" = p."conversation_id"
       WHERE p."owner_id" = $1 AND ((p."scope_kind" = 'workspace' AND p."scope_id" = $2)
         OR (h."scope" = 'workspace' AND h."workspace_id" = $2))`, input.ownerId, input.projectId)
  ];
  return [...identities, ...await selectProjectHomeEventIdentities(transaction, input)];
}

async function selectProjectHomeEventIdentities(
  transaction: StorageQuotaTransaction,
  input: { readonly ownerId: string; readonly projectId: string }
): Promise<readonly StorageContentIdentity[]> {
  const events = queryRows<{ readonly conversation_id: string; readonly sequence: number }>(await transaction.query(
    `SELECT e."conversation_id", e."sequence" FROM "home_conversation_events" e
     JOIN "home_conversations" h ON h."owner_id" = e."owner_id" AND h."id" = e."conversation_id"
     WHERE e."owner_id" = $1 AND h."scope" = 'workspace' AND h."workspace_id" = $2`,
    [input.ownerId, input.projectId]
  ));
  return events.map((event) => ({ entity: 'home_conversation_events', id: event.conversation_id, sequence: event.sequence }));
}

async function selectProjectContentIdentities(
  transaction: StorageQuotaTransaction,
  input: { readonly ownerId: string; readonly projectId: string }
): Promise<readonly StorageContentIdentity[]> {
  const definitions: readonly [StorageContentEntity, string][] = [
    ['projects', 'SELECT "id" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2'],
    ['conversations', 'SELECT "id" FROM "conversations" WHERE "owner_id" = $1 AND "project_id" = $2'],
    ['conversation_idempotency_keys', 'SELECT "id" FROM "conversation_idempotency_keys" WHERE "owner_id" = $1 AND "project_id" = $2'],
    ['messages', 'SELECT m."id" FROM "messages" m JOIN "conversations" c ON c."id" = m."conversation_id" WHERE c."owner_id" = $1 AND c."project_id" = $2'],
    ['project_tasks', 'SELECT "id" FROM "project_tasks" WHERE "owner_id" = $1 AND "project_id" = $2'],
    ['project_task_suggestions', 'SELECT "id" FROM "project_task_suggestions" WHERE "owner_id" = $1 AND "project_id" = $2'],
    ['project_facts', 'SELECT "id" FROM "project_facts" WHERE "owner_id" = $1 AND "project_id" = $2'],
    ['skill_revisions', 'SELECT r."id" FROM "skill_revisions" r JOIN "skills" s ON s."owner_id" = r."owner_id" AND s."id" = r."skill_id" WHERE s."owner_id" = $1 AND s."workspace_id" = $2'],
    ['ai_runs', 'SELECT "id" FROM "ai_runs" WHERE "owner_id" = $1 AND "project_id" = $2'],
    ['ai_run_change_sets', 'SELECT "id" FROM "ai_run_change_sets" WHERE "owner_id" = $1 AND "project_id" = $2'],
    ['sandbox_commands', 'SELECT "id" FROM "sandbox_commands" WHERE "owner_id" = $1 AND "project_id" = $2']
  ];
  const identities: StorageContentIdentity[] = [];
  for (const [entity, sql] of definitions) identities.push(...await selectIds(transaction, entity, sql, input.ownerId, input.projectId));
  identities.push(...await selectProjectHomeContentIdentities(transaction, input));
  return identities;
}

function removalContentScope(input: { readonly ownerId: string; readonly projectId: string }): StorageContentMutationScope<void> {
  let identities: readonly StorageContentIdentity[] = [];
  return {
    before: async (transaction) => {
      identities = await selectProjectContentIdentities(transaction, input);
      return identities;
    },
    after: async () => []
  };
}

/** Removes project records while retaining the trusted folder and its quota references. */
export class TypeOrmProjectRemovalRepository implements IProjectRemovalRepository {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly recoveryCleaner: IProjectRecoveryCleaner,
    private readonly storageAccounting: TypeOrmStorageContentAccounting,
    private readonly storageQuotaRepository: TypeOrmStorageQuotaRepository,
    private readonly rootMappings: IStorageRootMappingRepository
  ) {}

  /** Persists a removal barrier before filesystem quarantine and releases only verified recovery copies. */
  public async remove(input: RemoveProjectRecord): Promise<void> {
    const plan = await this.createRemovalJob(input);
    let quarantine: IProjectRecoveryQuarantine;
    try {
      quarantine = await this.recoveryCleaner.quarantine(plan.runIds);
    } catch {
      throw new ProjectRemovalCleanupPendingError();
    }
    await this.deleteProject(input, plan, quarantine);
    try {
      await quarantine.purge();
      await this.storageQuotaRepository.releaseRecoveryReferencesAfterVerifiedPurge(plan.ownerId, plan.projectId, plan.runIds);
      await this.deleteJob(plan.ownerId, plan.projectId);
    } catch {
      throw new ProjectRemovalCleanupPendingError();
    }
  }

  /** Repairs committed jobs before the application accepts project writes. */
  public async cleanupPending(): Promise<number> {
    const jobs = queryRows<RemovalJob>(await this.dataSource.query(
      'SELECT "owner_id", "project_id", "storage_root_key", "run_ids" FROM "project_removal_jobs" ORDER BY "created_at"'
    ));
    for (const job of jobs) await this.completeJob(job);
    return jobs.length;
  }

  private async createRemovalJob(input: RemoveProjectRecord): Promise<RemovalPlan> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let rootKey: string | null = null;
    try {
      const plan = await this.storageQuotaRepository.runDatabaseMutation(
        runner,
        { ownerId: input.ownerId, maximumGrowthBytes: 0n },
        async () => {
          const project = await lockProject(runner, input);
          const existing = queryRows<{ readonly project_id: string }>(await runner.query(
            'SELECT "project_id" FROM "project_removal_jobs" WHERE "owner_id" = $1 AND "project_id" = $2 FOR UPDATE',
            [input.ownerId, input.projectId]
          ));
          if (existing.length > 0) throw new ProjectRemovalBusyError();
          const runIds = await lockRuns(runner, input);
          await lockDependents(runner, input);
          if (project.relative_root_key !== rootKey) throw accountingUnavailable();
          await runner.query(
            'INSERT INTO "project_removal_jobs" ("owner_id", "project_id", "storage_root_key", "run_ids") VALUES ($1, $2, $3, $4::jsonb)',
            [input.ownerId, input.projectId, rootKey, JSON.stringify(runIds)]
          );
          return { result: { ownerId: input.ownerId, projectId: input.projectId, rootKey, runIds }, references: [] };
        },
        { beforeReferences: async () => { rootKey = await lockRootAndReservations(runner, input); } }
      );
      await runner.commitTransaction();
      return plan;
    } catch (error: unknown) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw isLockConflict(error) ? new ProjectRemovalBusyError() : error;
    } finally {
      await runner.release();
    }
  }

  private async deleteProject(input: RemoveProjectRecord, plan: RemovalPlan, quarantine: IProjectRecoveryQuarantine): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let commitAttempted = false;
    try {
      await this.storageAccounting.runMutation(
        runner,
        input.ownerId,
        async () => {
          const project = await lockProject(runner, input);
          const job = queryRows<RemovalJob>(await runner.query(
            'SELECT "owner_id", "project_id", "storage_root_key", "run_ids" FROM "project_removal_jobs" WHERE "owner_id" = $1 AND "project_id" = $2 FOR UPDATE',
            [input.ownerId, input.projectId]
          ));
          if (!job[0] || job[0].storage_root_key !== plan.rootKey || project.relative_root_key !== plan.rootKey) {
            throw new ProjectRemovalBusyError();
          }
          if (plan.rootKey) {
            await this.rootMappings.retainProjectRoot(runner, { ownerId: input.ownerId, projectId: input.projectId });
            await runner.query(
              `UPDATE "storage_resource_references" SET "resource_kind" = 'retained_root', "project_id" = NULL, "updated_at" = clock_timestamp()
               WHERE "owner_id" = $1 AND "resource_kind" = 'project_file' AND "root_key" = $2`,
              [input.ownerId, plan.rootKey]
            );
          }
          const removed = queryRows<{ readonly id: string }>(await runner.query(
            'DELETE FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 RETURNING "id"', [input.ownerId, input.projectId]
          ));
          if (removed.length !== 1) throw new ProjectNotFoundError();
        },
        removalContentScope(input),
        { beforeReferences: async () => {
          const rootKey = await lockRootAndReservations(runner, input);
          if (rootKey !== plan.rootKey) throw accountingUnavailable();
        } }
      );
      commitAttempted = true;
      await runner.commitTransaction();
    } catch (error: unknown) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (!commitAttempted) {
        await runner.release();
        try {
          await quarantine.restore();
          await this.deleteJob(input.ownerId, input.projectId);
        } catch {
          throw new ProjectRemovalCleanupPendingError();
        }
      }
      throw isLockConflict(error) ? new ProjectRemovalBusyError() : error;
    } finally {
      if (!runner.isReleased) await runner.release();
    }
  }

  private async completeJob(job: RemovalJob): Promise<void> {
    const runIds = parseRunIds(job.run_ids);
    const projects = queryRows<{ readonly id: string; readonly relative_root_key: string | null }>(await this.dataSource.query(
      'SELECT "id", "relative_root_key" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2', [job.owner_id, job.project_id]
    ));
    if (projects.length > 0) {
      if (projects[0]?.relative_root_key !== job.storage_root_key) throw accountingUnavailable();
      await this.recoveryCleaner.restore(runIds);
      await this.deleteJob(job.owner_id, job.project_id);
      return;
    }
    if (job.storage_root_key !== null) await this.assertRetainedRoot(job);
    await this.recoveryCleaner.purge(runIds);
    await this.storageQuotaRepository.releaseRecoveryReferencesAfterVerifiedPurge(job.owner_id, job.project_id, runIds);
    await this.deleteJob(job.owner_id, job.project_id);
  }

  private async assertRetainedRoot(job: RemovalJob): Promise<void> {
    const mappings = queryRows<{ readonly root_key: string }>(await this.dataSource.query(
      `SELECT "root_key" FROM "storage_root_mappings"
       WHERE "owner_id" = $1 AND "root_key" = $2 AND "locator_project_id" = $3 AND "state" = 'retained' AND "project_id" IS NULL`,
      [job.owner_id, job.storage_root_key, job.project_id]
    ));
    if (mappings.length !== 1) throw accountingUnavailable();
  }

  private async deleteJob(ownerId: string, projectId: string): Promise<void> {
    await this.dataSource.query(
      'DELETE FROM "project_removal_jobs" WHERE "owner_id" = $1 AND "project_id" = $2', [ownerId, projectId]
    );
  }
}
