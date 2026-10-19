import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';

import type { DemoExpiryCancellationPort, IDemoExpiryCleanupRepository } from '@/modules/demo/domain/demo-expiry-cleanup-types';
import type { IProjectRecoveryCleaner } from '@/modules/projects/repositories/project-removal-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import type { IStorageRootMappingRepository, StorageRootMapping } from '@/modules/storage-quotas/repositories/storage-root-mapping-repository';
import type { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';

interface CleanupManifest {
  readonly ownerId: string;
  readonly projectIds: readonly string[];
  readonly runs: readonly { readonly id: string; readonly projectId: string }[];
  readonly commands: readonly { readonly id: string; readonly runId: string }[];
  readonly reservations: readonly { readonly id: string; readonly rootKey: string; readonly status: string }[];
  readonly roots: readonly StorageRootMapping[];
  readonly copy: { readonly admissionId: string; readonly projectId: string; readonly hasManagedRoot: boolean } | null;
}

interface CleanupJob {
  readonly admission_id: string;
  readonly owner_id: string;
  readonly generation: string;
  readonly phase: 'fenced' | 'draining' | 'purging' | 'finalizing';
  readonly manifest: CleanupManifest | string;
  readonly lease_token: string;
  readonly attempts: number;
}

interface DueAdmission { readonly id: string; readonly owner_id: string; }
interface CopyRow {
  readonly target_project_id: string;
  readonly phase: string;
  readonly workspace_mode: 'planning' | 'file_backed' | null;
}
interface ProjectRow { readonly id: string; readonly relative_root: string | null; readonly storage_kind: 'managed' | 'legacy' | null; }
interface RunRow { readonly id: string; readonly project_id: string; }
interface CommandRow { readonly id: string; readonly run_id: string; }
interface RootRow {
  readonly owner_id: string; readonly project_id: string | null; readonly locator_project_id: string;
  readonly root_key: string; readonly storage_kind: 'managed' | 'legacy'; readonly relative_root: string;
  readonly state: 'active' | 'retained';
}

class UnsafeDemoRootError extends Error {}
class DemoCreditReservationBarrierError extends Error {
  public constructor(public readonly code: 'busy' | 'unknown_effect') { super(code); }
}

function rows<T>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) throw new Error('The demo expiry repository returned an unexpected query result.');
  if (value.length === 2 && Array.isArray(value[0]) && typeof value[1] === 'number') return value[0] as readonly T[];
  return value as readonly T[];
}

function parseManifest(value: CleanupManifest | string): CleanupManifest {
  const parsed = typeof value === 'string' ? JSON.parse(value) as CleanupManifest : value;
  if (!parsed || typeof parsed.ownerId !== 'string' || !Array.isArray(parsed.projectIds)
    || !Array.isArray(parsed.runs) || !Array.isArray(parsed.commands) || !Array.isArray(parsed.reservations)
    || !Array.isArray(parsed.roots)) throw new Error('The persisted demo cleanup manifest is invalid.');
  return parsed;
}

const ACTIVE_RUNS = "('pending_approval','staging','ready','queued','running','waiting_approval','cancel_requested')";
const ACTIVE_COMMANDS = "('awaiting_approval','running','cancel_requested')";

/** Bounded, leased demo cleanup. Unknown external effects remain barriers; no paths are persisted. */
export class TypeOrmDemoExpiryCleanupRepository implements IDemoExpiryCleanupRepository {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly workspace: IWorkspaceBoundary,
    private readonly recovery: IProjectRecoveryCleaner,
    private readonly roots: IStorageRootMappingRepository,
    private readonly quota: TypeOrmStorageQuotaRepository
  ) {}

  public async runBatch(cancellation: DemoExpiryCancellationPort, requestedLimit = 4): Promise<number> {
    const limit = Math.max(1, Math.min(16, Math.trunc(requestedLimit)));
    await this.fenceExpired(limit);
    const jobs = await this.claimJobs(limit);
    let completed = 0;
    for (const job of jobs) {
      try {
        if (job.phase === 'fenced') await this.setPhase(job, 'fenced', 'draining');
        const manifest = parseManifest(job.manifest);
        if (job.phase !== 'finalizing') {
          await this.requestCancellations(manifest, cancellation);
          const barrier = await this.getBarrier(manifest.ownerId);
          if (barrier) {
            await this.releaseForRetry(job, barrier);
            continue;
          }
          if (job.phase !== 'purging') await this.setPhase(job, 'draining', 'purging');
          await this.purge(job, manifest);
          await this.quota.purgeDemoOwnedReferences(job.owner_id, job.admission_id, job.generation, job.lease_token);
          await this.setPhase(job, 'purging', 'finalizing');
        }
        await this.finalize(job);
        completed += 1;
        } catch (error: unknown) {
        const failureCode = error instanceof UnsafeDemoRootError ? 'unsafe_root'
          : error instanceof DemoCreditReservationBarrierError ? error.code : 'storage';
        await this.releaseForRetry(job, failureCode);
      }
    }
    return completed;
  }

  private async fenceExpired(limit: number): Promise<number> {
    let fenced = 0;
    for (let index = 0; index < limit; index += 1) {
      const created = await this.dataSource.transaction(async (manager) => {
        const due = rows<DueAdmission>(await manager.query(`
          SELECT a."id", a."owner_id" FROM "demo_admissions" a
          JOIN "users" u ON u."id"=a."owner_id"
          WHERE a."owner_id" IS NOT NULL AND a."status" IN ('pending','ready','failed')
            AND u."account_kind"='demo'
            AND ((u."expires_at" IS NOT NULL AND u."expires_at"<=clock_timestamp())
              OR (a."expires_at" IS NOT NULL AND a."expires_at"<=clock_timestamp()))
            AND NOT EXISTS (SELECT 1 FROM "demo_expiry_cleanups" c WHERE c."admission_id"=a."id")
          ORDER BY COALESCE(u."expires_at",a."expires_at"),a."created_at"
          LIMIT 1 FOR UPDATE OF a SKIP LOCKED
        `))[0];
        if (!due) return false;
        const owner = rows<{ readonly id: string }>(await manager.query(
          `SELECT "id" FROM "users" WHERE "id"=$1 AND "account_kind"='demo' FOR UPDATE`, [due.owner_id]))[0];
        if (!owner) return false;
        const copy = rows<CopyRow>(await manager.query(`
          SELECT "target_project_id","phase","workspace_mode" FROM "demo_showcase_copies"
          WHERE "admission_id"=$1 AND "owner_id"=$2 FOR UPDATE
        `, [due.id, due.owner_id]))[0] ?? null;
        const projects = rows<ProjectRow>(await manager.query(
          `SELECT "id","relative_root","storage_kind" FROM "projects" WHERE "owner_id"=$1 ORDER BY "id"`, [due.owner_id]));
        const runs = rows<RunRow>(await manager.query(
          `SELECT "id","project_id" FROM "ai_runs" WHERE "owner_id"=$1 ORDER BY "id"`, [due.owner_id]));
        const commands = rows<CommandRow>(await manager.query(
          `SELECT "id","run_id" FROM "sandbox_commands" WHERE "owner_id"=$1 ORDER BY "id"`, [due.owner_id]));
        const reservations = rows<{ readonly id: string; readonly root_key: string; readonly status: string }>(await manager.query(
          `SELECT "id","root_key","status" FROM "storage_filesystem_reservations" WHERE "owner_id"=$1 ORDER BY "id"`, [due.owner_id]));
        const roots = rows<RootRow>(await manager.query(`
          SELECT "owner_id","project_id","locator_project_id","root_key","storage_kind","relative_root","state"
          FROM "storage_root_mappings" WHERE "owner_id"=$1 ORDER BY "root_key"
        `, [due.owner_id]));
        const receipt = copy ? rows<{ readonly outcome: string }>(await manager.query(
          `SELECT "outcome" FROM "demo_copy_effect_receipts" WHERE "admission_id"=$1`, [due.id]))[0] : null;
        const manifest: CleanupManifest = {
          ownerId: due.owner_id,
          projectIds: projects.map((project) => project.id),
          runs: runs.map((run) => ({ id: run.id, projectId: run.project_id })),
          commands: commands.map((command) => ({ id: command.id, runId: command.run_id })),
          reservations: reservations.map((reservation) => ({ id: reservation.id, rootKey: reservation.root_key, status: reservation.status })),
          roots: roots.map((root) => ({
            ownerId: root.owner_id, projectId: root.project_id, locatorProjectId: root.locator_project_id,
            rootKey: root.root_key, storageKind: root.storage_kind, relativeRoot: root.relative_root, state: root.state
          })),
          copy: copy ? {
            admissionId: due.id,
            projectId: copy.target_project_id,
            // A fenced root_pending copy may finish mkdir through its terminal receipt after this manifest commits.
            // Keep the exact target UUID so a later verified receipt can be purged after the barrier clears.
            hasManagedRoot: copy.workspace_mode === 'file_backed' || ['root_pending','root_created','database_created','files_pending','complete'].includes(copy.phase)
              || (receipt !== null && receipt !== undefined && receipt.outcome !== 'absent')
          } : null
        };
        await manager.query(`UPDATE "users" SET "is_active"=false,"updated_at"=clock_timestamp() WHERE "id"=$1`, [due.owner_id]);
        await manager.query(`UPDATE "demo_showcase_copies" SET "retry_allowed"=false,"claim_token"=NULL,
          "claim_expires_at"=NULL,"updated_at"=clock_timestamp() WHERE "admission_id"=$1 AND "owner_id"=$2`, [due.id, due.owner_id]);
        await manager.query(`INSERT INTO "demo_expiry_cleanups" ("admission_id","generation","phase","manifest")
          VALUES ($1,$2,'fenced',$3::jsonb)`, [due.id, randomUUID(), JSON.stringify(manifest)]);
        return true;
      });
      if (!created) break;
      fenced += 1;
    }
    return fenced;
  }

  private async claimJobs(limit: number): Promise<readonly CleanupJob[]> {
    return this.dataSource.transaction(async (manager) => {
      const due = rows<Omit<CleanupJob, 'lease_token'>>(await manager.query(`
        SELECT c."admission_id",a."owner_id",c."generation",c."phase",c."manifest",c."attempts"
        FROM "demo_expiry_cleanups" c JOIN "demo_admissions" a ON a."id"=c."admission_id"
        WHERE c."next_attempt_at"<=clock_timestamp()
          AND (c."lease_expires_at" IS NULL OR c."lease_expires_at"<=clock_timestamp())
        ORDER BY c."next_attempt_at",c."created_at" LIMIT $1 FOR UPDATE OF c SKIP LOCKED
      `, [limit]));
      const claimed: CleanupJob[] = [];
      for (const job of due) {
        const token = randomUUID();
        const updated = rows<Omit<CleanupJob, 'owner_id'>>(await manager.query(`
          UPDATE "demo_expiry_cleanups" SET "lease_token"=$2,"lease_expires_at"=clock_timestamp()+interval '5 minutes',
            "attempts"="attempts"+1,"updated_at"=clock_timestamp()
          WHERE "admission_id"=$1
          RETURNING "admission_id","generation","phase","manifest","lease_token","attempts"
        `, [job.admission_id, token]))[0];
        if (updated) claimed.push({ ...updated, owner_id: job.owner_id });
      }
      return claimed;
    });
  }

  private async requestCancellations(manifest: CleanupManifest, cancellation: DemoExpiryCancellationPort): Promise<void> {
    const activeRuns = rows<{ readonly id: string }>(await this.dataSource.query(
      `SELECT "id" FROM "ai_runs" WHERE "owner_id"=$1 AND "status" IN ${ACTIVE_RUNS}`, [manifest.ownerId]));
    for (const run of activeRuns) {
      try { await cancellation.cancelRun({ ownerId: manifest.ownerId, runId: run.id, idempotencyKey: `demo-expiry-${run.id}` }); } catch { /* persisted state below is the barrier */ }
    }
    const activeCommands = rows<{ readonly id: string; readonly run_id: string }>(await this.dataSource.query(
      `SELECT "id","run_id" FROM "sandbox_commands" WHERE "owner_id"=$1 AND "status" IN ${ACTIVE_COMMANDS}`, [manifest.ownerId]));
    for (const command of activeCommands) {
      try {
        await cancellation.cancelCommand({ ownerId: manifest.ownerId, runId: command.run_id, commandId: command.id,
          idempotencyKey: `demo-expiry-${command.id}` });
      } catch { /* persisted state below is the barrier */ }
    }
  }

  private async getBarrier(ownerId: string): Promise<'busy' | 'unknown_effect' | null> {
    const result = rows<{ readonly active_run: boolean; readonly uncertain_provider: boolean; readonly active_command: boolean;
      readonly unresolved_reservation: boolean; readonly unresolved_root_effect: boolean; readonly removal_job: boolean;
      readonly active_credit_reservation: boolean; readonly uncertain_credit_reservation: boolean }>(await this.dataSource.query(`
      SELECT EXISTS(SELECT 1 FROM "ai_runs" WHERE "owner_id"=$1 AND ("status" IN ${ACTIVE_RUNS} OR "status"='review_required')) AS "active_run",
        EXISTS(SELECT 1 FROM "ai_runs" WHERE "owner_id"=$1 AND "provider_transmission"='unknown') AS "uncertain_provider",
        EXISTS(SELECT 1 FROM "sandbox_commands" WHERE "owner_id"=$1 AND ("status" IN ${ACTIVE_COMMANDS} OR "status"='review_required')) AS "active_command",
        EXISTS(SELECT 1 FROM "storage_filesystem_reservations" WHERE "owner_id"=$1 AND "status" IN ('pending','unknown')) AS "unresolved_reservation",
        EXISTS(SELECT 1 FROM "demo_copy_effect_receipts" r JOIN "demo_admissions" a ON a."id"=r."admission_id"
          WHERE a."owner_id"=$1 AND r."outcome" IN ('pending','unknown')) AS "unresolved_root_effect",
        EXISTS(SELECT 1 FROM "credit_provider_call_reservations" WHERE "owner_id"=$1 AND "status"='in_flight') AS "active_credit_reservation",
        EXISTS(SELECT 1 FROM "credit_provider_call_reservations" WHERE "owner_id"=$1 AND "status"='unknown') AS "uncertain_credit_reservation",
        EXISTS(SELECT 1 FROM "project_removal_jobs" WHERE "owner_id"=$1) AS "removal_job"
    `, [ownerId]))[0];
    if (!result) return 'busy';
    if (result.uncertain_provider || result.unresolved_root_effect || result.unresolved_reservation
      || result.uncertain_credit_reservation) return 'unknown_effect';
    if (result.active_run || result.active_command || result.removal_job || result.active_credit_reservation) return 'busy';
    return null;
  }

  private async purge(job: CleanupJob, manifest: CleanupManifest): Promise<void> {
    const blocker = await this.getBarrier(manifest.ownerId);
    if (blocker) throw new Error(blocker);
    const namespace = await this.workspace.inspectManagedNamespace?.();
    const ownerNamespace = namespace?.owners.find((entry) => entry.ownerId === manifest.ownerId);
    const expectedRootIds = new Set(manifest.roots.map((root) => root.locatorProjectId));
    if (manifest.copy?.hasManagedRoot) expectedRootIds.add(manifest.copy.projectId);
    if (manifest.roots.length > 0 || manifest.copy?.hasManagedRoot) {
      if (!namespace?.configured || namespace.unattributableEntries || !ownerNamespace || ownerNamespace.unsafe
        || ownerNamespace.projectIds.some((projectId) => !expectedRootIds.has(projectId))) throw new UnsafeDemoRootError();
    }

    const runsByProject = new Map<string, string[]>();
    for (const run of manifest.runs) runsByProject.set(run.projectId, [...(runsByProject.get(run.projectId) ?? []), run.id]);
    for (const [projectId, runIds] of runsByProject) {
      await this.assertLease(job);
      await this.recovery.purge(runIds);
      await this.quota.releaseRecoveryReferencesAfterVerifiedPurge(manifest.ownerId, projectId, runIds);
    }

    const liveMappings = await this.roots.listMappings(manifest.ownerId);
    for (const mapping of liveMappings) {
      const recorded = manifest.roots.find((root) => root.rootKey === mapping.rootKey);
      if (!recorded || recorded.locatorProjectId !== mapping.locatorProjectId || recorded.relativeRoot !== mapping.relativeRoot
        || recorded.storageKind !== mapping.storageKind || mapping.storageKind !== 'managed'
        || mapping.relativeRoot !== `projects/${mapping.locatorProjectId}`) throw new UnsafeDemoRootError();
    }
    for (const recorded of manifest.roots) {
      if (recorded.storageKind !== 'managed' || recorded.relativeRoot !== `projects/${recorded.locatorProjectId}`) throw new UnsafeDemoRootError();
      const mapping = liveMappings.find((entry) => entry.rootKey === recorded.rootKey);
      if (mapping?.state === 'active') {
        await this.quota.retireDemoProjectRoot(manifest.ownerId, recorded.locatorProjectId, recorded.rootKey,
          job.admission_id, job.generation, job.lease_token);
      }
      await this.assertLease(job);
      if (!this.workspace.removeManagedProjectRoot) throw new Error('unsafe root');
      await this.workspace.removeManagedProjectRoot(manifest.ownerId, recorded.locatorProjectId);
      await this.quota.releaseDemoProjectReferencesAfterVerifiedPurge(manifest.ownerId, recorded.rootKey,
        job.admission_id, job.generation, job.lease_token);
      if (mapping) await this.quota.deleteDemoRetainedRoot(manifest.ownerId, recorded.rootKey,
        job.admission_id, job.generation, job.lease_token);
    }

    const mappedProjects = new Set(manifest.roots.map((root) => root.projectId ?? root.locatorProjectId));
    for (const projectId of manifest.projectIds) {
      if (mappedProjects.has(projectId)) continue;
      const project = rows<ProjectRow>(await this.dataSource.query(
        `SELECT "id","relative_root","storage_kind" FROM "projects" WHERE "owner_id"=$1 AND "id"=$2`, [manifest.ownerId, projectId]))[0];
      if (project && project.relative_root !== null) throw new UnsafeDemoRootError();
      if (project) await this.quota.retireDemoProjectRoot(manifest.ownerId, projectId, null,
        job.admission_id, job.generation, job.lease_token);
    }

    if (manifest.copy?.hasManagedRoot && !manifest.roots.some((root) => root.locatorProjectId === manifest.copy?.projectId)) {
      if (liveMappings.some((mapping) => mapping.locatorProjectId === manifest.copy?.projectId)) throw new UnsafeDemoRootError();
      if (!this.workspace.removeManagedProjectRoot) throw new Error('unsafe root');
      await this.assertLease(job);
      await this.workspace.removeManagedProjectRoot(manifest.ownerId, manifest.copy.projectId);
      const rootKey = `projects/${manifest.copy.projectId}`.toLowerCase();
      await this.quota.releaseDemoProjectReferencesAfterVerifiedPurge(manifest.ownerId, rootKey,
        job.admission_id, job.generation, job.lease_token);
    }

  }

  private async assertLease(job: CleanupJob): Promise<void> {
    const current = rows<{ readonly id: string }>(await this.dataSource.query(`
      SELECT "admission_id" AS "id" FROM "demo_expiry_cleanups"
      WHERE "admission_id"=$1 AND "generation"=$2 AND "lease_token"=$3 AND "lease_expires_at">clock_timestamp()
    `, [job.admission_id, job.generation, job.lease_token]));
    if (current.length !== 1) throw new Error('lease lost');
  }

  private async setPhase(job: CleanupJob, from: CleanupJob['phase'], to: CleanupJob['phase']): Promise<void> {
    const updated = rows<{ readonly id: string }>(await this.dataSource.query(`
      UPDATE "demo_expiry_cleanups" SET "phase"=$4,"failure_code"=NULL,"updated_at"=clock_timestamp()
      WHERE "admission_id"=$1 AND "generation"=$2 AND "lease_token"=$3 AND "lease_expires_at">clock_timestamp() AND "phase"=$5
      RETURNING "admission_id" AS "id"
    `, [job.admission_id, job.generation, job.lease_token, to, from]));
    if (updated.length !== 1) throw new Error('lease lost');
  }

  private async releaseForRetry(job: CleanupJob, code: 'busy' | 'unknown_effect' | 'unsafe_root' | 'storage'): Promise<void> {
    await this.dataSource.query(`
      UPDATE "demo_expiry_cleanups" SET "lease_token"=NULL,"lease_expires_at"=NULL,
        "next_attempt_at"=clock_timestamp()+interval '1 minute',"failure_code"=$4,"updated_at"=clock_timestamp()
      WHERE "admission_id"=$1 AND "generation"=$2 AND "lease_token"=$3
    `, [job.admission_id, job.generation, job.lease_token, code]);
  }

  private async finalize(job: CleanupJob): Promise<void> {
    await this.dataSource.transaction(async (manager: EntityManager) => {
      const admission = rows<{ readonly id: string }>(await manager.query(
        'SELECT "id" FROM "demo_admissions" WHERE "id"=$1 AND "owner_id"=$2 FOR UPDATE', [job.admission_id, job.owner_id]))[0];
      if (!admission) throw new Error('cleanup owner unavailable');
      const owner = rows<{ readonly id: string }>(await manager.query(
        `SELECT "id" FROM "users" WHERE "id"=$1 AND "account_kind"='demo' AND "is_active"=false FOR UPDATE`, [job.owner_id]))[0];
      if (!owner) throw new Error('cleanup owner unavailable');
      await manager.query('SELECT "admission_id" FROM "demo_showcase_copies" WHERE "admission_id"=$1 FOR UPDATE', [job.admission_id]);
      const cleanup = rows<{ readonly id: string }>(await manager.query(`
        SELECT "admission_id" AS "id" FROM "demo_expiry_cleanups"
        WHERE "admission_id"=$1 AND "generation"=$2 AND "lease_token"=$3 AND "lease_expires_at">clock_timestamp() AND "phase"='finalizing' FOR UPDATE
      `, [job.admission_id, job.generation, job.lease_token]));
      if (cleanup.length !== 1) throw new Error('lease lost');
      const barrier = await this.getBarrier(job.owner_id);
      if (barrier) throw new Error(barrier);
      const leftovers = rows<{ readonly count: string | number }>(await manager.query(`
        SELECT (SELECT count(*) FROM "projects" WHERE "owner_id"=$1)
          +(SELECT count(*) FROM "storage_root_mappings" WHERE "owner_id"=$1)
          +(SELECT count(*) FROM "storage_resource_references" WHERE "owner_id"=$1)
          +(SELECT count(*) FROM "storage_filesystem_reservations" WHERE "owner_id"=$1) AS "count"
      `, [job.owner_id]));
      if (Number(leftovers[0]?.count ?? 1) !== 0) throw new Error('cleanup leftovers');
      await manager.query('INSERT INTO "account_limits" ("owner_id") VALUES ($1) ON CONFLICT ("owner_id") DO NOTHING', [job.owner_id]);
      await manager.query('SELECT "owner_id" FROM "account_limits" WHERE "owner_id"=$1 FOR UPDATE', [job.owner_id]);
      const totals = rows<{ readonly used_bytes: string; readonly reserved_bytes: string }>(await manager.query(
        'SELECT "used_bytes","reserved_bytes" FROM "storage_account_totals" WHERE "owner_id"=$1 FOR UPDATE', [job.owner_id]))[0];
      if (!totals || BigInt(totals.used_bytes) !== 0n || BigInt(totals.reserved_bytes) !== 0n) throw new Error('storage not empty');
      const creditReservations = rows<{ readonly id: string; readonly status: 'in_flight' | 'unknown' | 'settled' | 'released' | 'over_bound' }>(
        await manager.query(`SELECT "id","status" FROM "credit_provider_call_reservations"
          WHERE "owner_id"=$1 ORDER BY "id" FOR UPDATE`, [job.owner_id]));
      if (creditReservations.some((reservation) => reservation.status === 'unknown')) {
        throw new DemoCreditReservationBarrierError('unknown_effect');
      }
      if (creditReservations.some((reservation) => reservation.status === 'in_flight')) {
        throw new DemoCreditReservationBarrierError('busy');
      }
      await manager.query('UPDATE "credit_usage_entries" SET "owner_id"=NULL WHERE "owner_id"=$1', [job.owner_id]);
      await manager.query(`UPDATE "credit_provider_call_reservations" SET "owner_id"=NULL
        WHERE "owner_id"=$1 AND "status" IN ('settled','released','over_bound')`, [job.owner_id]);
      await manager.query('DELETE FROM "demo_copy_effect_receipts" WHERE "admission_id"=$1', [job.admission_id]);
      await manager.query('DELETE FROM "demo_showcase_copies" WHERE "admission_id"=$1', [job.admission_id]);
      const tombstone = await manager.query(`UPDATE "demo_admissions" SET "status"='failed',"failure_code"='expired',
        "updated_at"=clock_timestamp() WHERE "id"=$1 AND "owner_id"=$2 RETURNING "id"`, [job.admission_id, job.owner_id]);
      if (rows<{ readonly id: string }>(tombstone).length !== 1) throw new Error('tombstone missing');
      const deletedOwner = rows<{ readonly id: string }>(await manager.query(
        `DELETE FROM "users" WHERE "id"=$1 AND "account_kind"='demo' AND "is_active"=false RETURNING "id"`, [job.owner_id]));
      if (deletedOwner.length !== 1) throw new Error('owner deletion failed');
      await manager.query('DELETE FROM "demo_expiry_cleanups" WHERE "admission_id"=$1 AND "generation"=$2 AND "lease_token"=$3',
        [job.admission_id, job.generation, job.lease_token]);
    });
  }
}
