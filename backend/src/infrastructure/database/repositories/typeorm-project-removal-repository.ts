import type { DataSource, QueryRunner } from 'typeorm';

import { ProjectNotFoundError, ProjectRecoveryCleanupError, ProjectRemovalBusyError, ProjectRemovalCleanupPendingError, ProjectVersionConflictError } from '@/modules/projects/domain/project-errors';
import type { IProjectRecoveryCleaner, IProjectRecoveryQuarantine, IProjectRemovalRepository, RemoveProjectRecord } from '@/modules/projects/repositories/project-removal-repository';

interface RunState {
  readonly id: string;
  readonly status: string;
  readonly cleanup: string;
}

interface RemovalJob {
  readonly project_id: string;
  readonly run_ids: unknown;
}

function parseRunIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) throw new ProjectRecoveryCleanupError();
  return value;
}

function isLockConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error.code === '55P03' || error.code === '40P01');
}

async function lockProject(runner: QueryRunner, input: RemoveProjectRecord): Promise<void> {
  const rows: readonly { readonly version: number }[] = await runner.query(
    'SELECT "version" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 FOR UPDATE NOWAIT', [input.ownerId, input.projectId]);
  if (!rows[0]) throw new ProjectNotFoundError();
  if (rows[0].version !== input.expectedVersion) throw new ProjectVersionConflictError();
}

async function lockRuns(runner: QueryRunner, input: RemoveProjectRecord): Promise<readonly string[]> {
  const rows: readonly RunState[] = await runner.query(
    'SELECT "id", "status", "cleanup" FROM "ai_runs" WHERE "owner_id" = $1 AND "project_id" = $2 ORDER BY "id" FOR UPDATE NOWAIT',
    [input.ownerId, input.projectId]);
  const terminal = ['succeeded', 'failed', 'blocked', 'cancelled', 'rejected'];
  if (rows.some((row) => !terminal.includes(row.status) || row.cleanup === 'unknown')) throw new ProjectRemovalBusyError();
  return rows.map((row) => row.id);
}

async function lockDependents(runner: QueryRunner, input: RemoveProjectRecord): Promise<void> {
  const parameters = [input.ownerId, input.projectId];
  const changes: readonly { readonly status: string }[] = await runner.query(
    'SELECT "status" FROM "ai_run_change_sets" WHERE "owner_id" = $1 AND "project_id" = $2 ORDER BY "id" FOR UPDATE NOWAIT', parameters);
  const commands: readonly { readonly status: string }[] = await runner.query(
    'SELECT "status" FROM "sandbox_commands" WHERE "owner_id" = $1 AND "project_id" = $2 ORDER BY "id" FOR UPDATE NOWAIT', parameters);
  if (changes.some((row) => ['awaiting_approval', 'applying', 'needs_manual_review'].includes(row.status)) ||
      commands.some((row) => ['awaiting_approval', 'running', 'cancel_requested', 'review_required'].includes(row.status))) {
    throw new ProjectRemovalBusyError();
  }
}

/** Locks executing-operation records before cascading project-owned application data. */
export class TypeOrmProjectRemovalRepository implements IProjectRemovalRepository {
  public constructor(private readonly dataSource: DataSource, private readonly recoveryCleaner: IProjectRecoveryCleaner) {}

  public async remove(input: RemoveProjectRecord): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let quarantine: IProjectRecoveryQuarantine | undefined;
    let jobCreated = false;
    let runIds: readonly string[] = [];
    let commitAttempted = false;
    try {
      await lockProject(runner, input);
      runIds = await lockRuns(runner, input);
      await lockDependents(runner, input);
      await this.dataSource.query('INSERT INTO "project_removal_jobs" ("project_id", "run_ids") VALUES ($1, $2::jsonb)',
        [input.projectId, JSON.stringify(runIds)]);
      jobCreated = true;
      quarantine = await this.recoveryCleaner.quarantine(runIds);
      await runner.query('DELETE FROM "projects" WHERE "owner_id" = $1 AND "id" = $2', [input.ownerId, input.projectId]);
      commitAttempted = true;
      await runner.commitTransaction();
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      if (jobCreated) {
        // A lost commit response is ambiguous: inspect committed state before restoring history.
        if (commitAttempted) await this.completeJob({ project_id: input.projectId, run_ids: runIds });
        else await this.recoveryCleaner.restore(runIds);
      }
      if (jobCreated) await this.deleteJob(input.projectId);
      throw isLockConflict(error) ? new ProjectRemovalBusyError() : error;
    } finally {
      await runner.release();
    }
    try { await quarantine?.purge(); await this.deleteJob(input.projectId); }
    catch (error: unknown) { throw new ProjectRemovalCleanupPendingError(); }
  }

  /** Called at startup before accepting requests; safely repairs interrupted removals. */
  public async cleanupPending(): Promise<number> {
    const jobs: readonly RemovalJob[] = await this.dataSource.query('SELECT "project_id", "run_ids" FROM "project_removal_jobs" ORDER BY "created_at"');
    for (const job of jobs) { await this.completeJob(job); await this.deleteJob(job.project_id); }
    return jobs.length;
  }

  private async completeJob(job: RemovalJob): Promise<void> {
    const projects: readonly { readonly id: string }[] = await this.dataSource.query('SELECT "id" FROM "projects" WHERE "id" = $1', [job.project_id]);
    const runIds = parseRunIds(job.run_ids);
    if (projects.length > 0) await this.recoveryCleaner.restore(runIds);
    else await this.recoveryCleaner.purge(runIds);
  }

  private async deleteJob(projectId: string): Promise<void> {
    await this.dataSource.query('DELETE FROM "project_removal_jobs" WHERE "project_id" = $1', [projectId]);
  }
}
