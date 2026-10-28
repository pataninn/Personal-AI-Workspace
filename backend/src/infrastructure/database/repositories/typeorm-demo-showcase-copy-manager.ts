import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';

import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { normalizeProjectName, projectRootOverlapKey } from '@/modules/projects/domain/project-root-policy';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import type { CurrentShowcaseDto, IShowcaseRepository, ShowcaseStoredVersion } from '@/modules/showcases/domain/showcase-types';
import type { DemoShowcaseCopyDto, IDemoShowcaseCopyManager } from '@/modules/demo/domain/demo-showcase-copy-types';
import type { ShowcaseLimits } from '@/modules/showcases/domain/showcase-types';
import type { TypeOrmProjectFileAccess } from '@/infrastructure/database/repositories/typeorm-project-file-access';
import type { ProjectFileGateway } from '@/infrastructure/workspace/project-file-gateway';
import type { StorageQuotaFileMutation } from '@/infrastructure/workspace/storage-quota-file-mutation';
import { StorageQuotaKnownOutcomeError } from '@/infrastructure/workspace/storage-quota-file-mutation';
import type { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import type { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import type { StorageFileOperationCommand, StorageFileReferencePlan, StorageTrustedFileScope, StorageVerifiedFileChange } from '@/modules/storage-quotas/domain/storage-quota-types';
import { storageFileOperationFingerprint } from '@/modules/storage-quotas/domain/storage-file-operation-fingerprint';
import { StorageQuotaError } from '@/modules/storage-quotas/domain/storage-quota-errors';
import { AppError } from '@/shared/errors/app-error';

type CopyPhase = 'queued' | 'root_pending' | 'root_created' | 'database_created' | 'files_pending' | 'complete' | 'unknown';
interface CopyIdMap {
  readonly tasks: Readonly<Record<string, string>>;
  readonly checklists: Readonly<Record<string, string>>;
  readonly facts: Readonly<Record<string, string>>;
  readonly skills: Readonly<Record<string, string>>;
}
interface CopyRow {
  readonly copy_id: string;
  readonly owner_id: string;
  readonly pinned_version_id: string | null;
  readonly target_project_id: string;
  readonly state: 'pending' | 'ready' | 'failed';
  readonly phase: CopyPhase;
  readonly claim_token: string | null;
  readonly claim_expires_at: Date | string | null;
  readonly attempts: number;
  readonly retry_allowed: boolean;
  readonly id_map: CopyIdMap | string;
  readonly workspace_mode: 'planning' | 'file_backed' | null;
  readonly file_access: boolean | null;
};
type CopyStatusRow = Pick<CopyRow, 'target_project_id' | 'state' | 'retry_allowed' | 'workspace_mode' | 'file_access'>;

function rows<T>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) throw new Error('The demo copy repository returned an unexpected query result.');
  if (value.length === 2 && Array.isArray(value[0]) && typeof value[1] === 'number') return value[0] as readonly T[];
  return value as readonly T[];
}

function parseJson<T>(value: T | string): T { return typeof value === 'string' ? JSON.parse(value) as T : value; }

function completeIdMap(snapshot: CurrentShowcaseDto, stored: Partial<CopyIdMap>): CopyIdMap {
  const makeIds = (sourceIds: readonly string[], previous: Readonly<Record<string, string>> | undefined): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const sourceId of sourceIds) {
      const existing = previous?.[sourceId];
      if (existing === undefined) result[sourceId] = randomUUID();
      else if (isUuid(existing)) result[sourceId] = existing;
      else throw storageUnavailable();
    }
    return result;
  };
  return {
    tasks: makeIds(snapshot.tasks.map(({ id }) => id), stored.tasks),
    checklists: makeIds(snapshot.tasks.flatMap(({ checklist }) => checklist.map(({ id }) => id)), stored.checklists),
    facts: makeIds(snapshot.facts.map(({ id }) => id), stored.facts),
    skills: makeIds(snapshot.skills.map(({ id }) => id), stored.skills)
  };
}

function asMap(row: CopyRow): CopyIdMap { return parseJson(row.id_map); }

function safeFailureCode(error: unknown): 'quota' | 'storage' | 'unknown_side_effect' {
  if (error instanceof StorageQuotaError && ['STORAGE_QUOTA_EXCEEDED', 'STORAGE_ACCOUNTING_UNAVAILABLE'].includes(error.code)) return 'quota';
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'STORAGE_QUOTA_EXCEEDED') return 'quota';
  if (error instanceof StorageQuotaKnownOutcomeError) return 'unknown_side_effect';
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'STORAGE_RECONCILIATION_PENDING') return 'unknown_side_effect';
  return 'storage';
}

function isUuid(value: string | null | undefined): value is string { return value !== null && value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value); }

export class TypeOrmDemoShowcaseCopyManager implements IDemoShowcaseCopyManager {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly showcases: IShowcaseRepository,
    private readonly projects: IProjectRepository,
    private readonly workspaceBoundary: IWorkspaceBoundary,
    private readonly fileAccess: TypeOrmProjectFileAccess,
    private readonly fileGateway: ProjectFileGateway,
    private readonly fileMutations: StorageQuotaFileMutation,
    private readonly quota: TypeOrmStorageQuotaRepository,
    private readonly contentAccounting: TypeOrmStorageContentAccounting,
    private readonly limits: ShowcaseLimits | undefined
  ) {}

  public async isReady(ownerId: string): Promise<boolean> {
    const result = rows<{ readonly ready: boolean }>(await this.dataSource.query(`
      SELECT bool_and(c."state" = 'ready' AND u."is_active" = true
        AND (u."expires_at" IS NULL OR u."expires_at" > clock_timestamp())) AS "ready"
      FROM "demo_showcase_copies" c JOIN "users" u ON u."id" = c."owner_id"
      WHERE c."owner_id" = $1
    `, [ownerId]))[0];
    return result?.ready === true;
  }

  public async getStatus(ownerId: string): Promise<DemoShowcaseCopyDto> {
    const copies = rows<CopyStatusRow>(await this.dataSource.query(`
      SELECT "target_project_id", "state", "retry_allowed", "workspace_mode", "file_access"
      FROM "demo_showcase_copies" WHERE "owner_id" = $1
      ORDER BY ("copy_id" = "admission_id") DESC, "copy_id"
    `, [ownerId]));
    if (copies.length === 0) return { state: 'failed', projectId: null, retryAllowed: false, workspaceMode: null, capabilities: null };
    const incomplete = copies.filter((copy) => copy.state !== 'ready');
    if (incomplete.length > 0) {
      return {
        state: incomplete.some((copy) => copy.state === 'failed') ? 'failed' : 'pending',
        projectId: null, workspaceMode: null, capabilities: null,
        retryAllowed: this.limits !== undefined && incomplete.every((copy) => copy.state === 'pending' || copy.retry_allowed)
      };
    }
    return toDto(copies[0]!);
  }

  public async provision(admissionId: string, ownerId: string): Promise<void> {
    const copies = rows<{ readonly copy_id: string }>(await this.dataSource.query(`
      SELECT "copy_id" FROM "demo_showcase_copies" WHERE "admission_id" = $1 AND "owner_id" = $2
      ORDER BY ("copy_id" = "admission_id") DESC, "copy_id"
    `, [admissionId, ownerId]));
    for (const copy of copies) await this.run(copy.copy_id, ownerId);
  }

  public async retry(ownerId: string): Promise<DemoShowcaseCopyDto> {
    if (!this.limits) throw notRetryable();
    const admission = rows<{ readonly admission_id: string }>(await this.dataSource.query(`
      SELECT "admission_id" FROM "demo_showcase_copies" WHERE "owner_id" = $1 LIMIT 1
    `, [ownerId]))[0];
    if (!admission) throw notRetryable();
    const status = await this.getStatus(ownerId);
    if (status.state === 'ready') return status;
    if (status.state === 'failed' && !status.retryAllowed) throw notRetryable();
    await this.provision(admission.admission_id, ownerId);
    const result = await this.getStatus(ownerId);
    if (result.state === 'failed' && !result.retryAllowed) throw notRetryable();
    return result;
  }

  private async run(copyId: string, ownerId: string): Promise<void> {
    const initial = await this.readCopy(copyId, ownerId);
    if (!initial || !initial.pinned_version_id || initial.state === 'ready') return;
    const version = await this.showcases.getVersion(initial.pinned_version_id);
    if (!version) { await this.fail(copyId, ownerId, null, 'unknown_side_effect', false, true); return; }
    const claim = await this.claim(copyId, ownerId, version);
    if (!claim) return;
    const { row, claimToken, snapshot, files } = claim;
    const idMap = asMap(row);
    const projectId = row.target_project_id;
    const hasFiles = files.length > 0;

    try {
      let project = await this.projects.findByIdForOwner(ownerId, projectId);
      if (!project) {
        let relativeRoot: string | null = null;
        let storageKind: 'managed' | null = null;
        if (hasFiles) {
          if (row.phase === 'root_pending') {
            if (!this.workspaceBoundary.createManagedProjectRoot) {
              await this.finishRootEffect(copyId, ownerId, projectId, claimToken, 'absent');
              throw storageUnavailable();
            }
            try {
              relativeRoot = await this.workspaceBoundary.createManagedProjectRoot(ownerId, projectId);
              await this.finishRootEffect(copyId, ownerId, projectId, claimToken, 'verified');
            } catch (error: unknown) {
              await this.finishRootEffect(copyId, ownerId, projectId, claimToken, 'unknown');
              throw error;
            }
            if (!relativeRoot) throw storageUnavailable();
            await this.advance(copyId, ownerId, claimToken, 'root_created');
          } else if (row.phase === 'root_created' || row.phase === 'database_created' || row.phase === 'files_pending') {
            relativeRoot = `projects/${projectId}`;
          } else {
            throw storageUnavailable();
          }
          storageKind = 'managed';
        }
        const identity = normalizeProjectName(snapshot.project.name);
        project = await this.projects.create({
          id: projectId,
          ownerId,
          name: identity.name,
          slug: identity.slug,
          relativeRoot,
          storageKind,
          relativeRootKey: relativeRoot === null ? null : projectRootOverlapKey(relativeRoot),
          objective: snapshot.project.objective
        });
      } else if (project.ownerId !== ownerId || project.status !== 'active') {
        throw storageUnavailable();
      }

      await this.cloneRows(copyId, ownerId, claimToken, projectId, snapshot, idMap);
      if (hasFiles) {
        await this.advance(copyId, ownerId, claimToken, 'files_pending');
        for (const file of files) await this.copyFile(copyId, ownerId, projectId, file);
      }
      await this.finish(copyId, ownerId, claimToken, projectId, snapshot, files);
    } catch (error: unknown) {
      const failure = safeFailureCode(error);
      const retryAllowed = failure === 'quota' && this.limits !== undefined && row.attempts < this.limits.maxCopyAttempts;
      await this.fail(copyId, ownerId, claimToken, failure, retryAllowed, failure === 'unknown_side_effect');
    }
  }

  private async readCopy(copyId: string, ownerId: string): Promise<CopyRow | null> {
    return rows<CopyRow>(await this.dataSource.query(`
      SELECT c."copy_id", c."owner_id", c."pinned_version_id", c."target_project_id", c."state", c."phase",
        c."claim_token", c."claim_expires_at", c."attempts", c."retry_allowed", c."id_map", c."workspace_mode", c."file_access"
      FROM "demo_showcase_copies" c WHERE c."copy_id" = $1 AND c."owner_id" = $2 LIMIT 1
    `, [copyId, ownerId]))[0] ?? null;
  }

  private async claim(copyId: string, ownerId: string, version: ShowcaseStoredVersion): Promise<{
    readonly row: CopyRow; readonly claimToken: string; readonly snapshot: CurrentShowcaseDto; readonly files: ShowcaseStoredVersion['files'];
  } | null> {
    return this.dataSource.transaction(async (manager) => {
      const locked = await this.lockCopy(manager, copyId, ownerId);
      if (!locked) return null;
      const row = locked.copy;
      if (row.state === 'ready') return null;
      if (row.pinned_version_id === null) {
        await manager.query(`UPDATE "demo_showcase_copies" SET "state"='failed', "phase"='unknown', "retry_allowed"=false, "failure_code"='expired', "updated_at"=clock_timestamp() WHERE "copy_id"=$1`, [copyId]);
        return null;
      }
      if (!locked.owner_active) {
        await manager.query(`UPDATE "demo_showcase_copies" SET "state"='failed', "phase"='unknown', "retry_allowed"=false, "failure_code"='expired', "claim_token"=NULL, "claim_expires_at"=NULL, "updated_at"=clock_timestamp() WHERE "copy_id"=$1`, [copyId]);
        return null;
      }
      if (locked.admission_status !== 'ready') return null;
      if (locked.copy_claim_live) return null;
      let rootReceipt: 'absent' | 'verified' | 'unknown' | 'pending' | null = null;
      if (row.phase === 'root_pending') {
        rootReceipt = rows<{ readonly outcome: 'absent' | 'verified' | 'unknown' | 'pending' }>(await manager.query(
          'SELECT "outcome" FROM "demo_copy_effect_receipts" WHERE "copy_id"=$1 FOR UPDATE', [copyId]
        ))[0]?.outcome ?? null;
        if (rootReceipt === null || rootReceipt === 'pending' || rootReceipt === 'unknown') return null;
      }
      if (row.state === 'failed' && !row.retry_allowed) return null;
      if (!this.limits) return null;
      if (row.attempts >= this.limits.maxCopyAttempts) {
        await manager.query(`UPDATE "demo_showcase_copies" SET "state"='failed', "retry_allowed"=false, "updated_at"=clock_timestamp() WHERE "copy_id"=$1`, [copyId]);
        return null;
      }
      const claimToken = randomUUID();
      const persistedMap = completeIdMap(version.snapshot, parseJson(row.id_map));
      const phase: CopyPhase = row.phase === 'queued' && version.files.length > 0 ? 'root_pending'
        : row.phase === 'root_pending' && rootReceipt === 'verified' ? 'root_created' : row.phase;
      const updated = rows<CopyRow>(await manager.query(`
        UPDATE "demo_showcase_copies" SET "state"='pending', "phase"=$2, "claim_token"=$3,
          "claim_expires_at"=clock_timestamp() + interval '5 minutes', "attempts"="attempts" + 1,
          "retry_allowed"=false, "id_map"=$4::jsonb, "updated_at"=clock_timestamp()
        WHERE "copy_id"=$1
        RETURNING "copy_id", "owner_id", "pinned_version_id", "target_project_id", "state", "phase",
          "claim_token", "claim_expires_at", "attempts", "retry_allowed", "id_map", "workspace_mode", "file_access"
      `, [copyId, phase, claimToken, JSON.stringify(persistedMap)]));
      const claimed = updated[0];
      if (!claimed) return null;
      if (phase === 'root_pending' && row.phase === 'queued') {
        await manager.query(`INSERT INTO "demo_copy_effect_receipts"
          ("copy_id", "admission_id", "owner_id", "project_id", "effect_kind", "claim_token", "outcome")
          SELECT $1,c."admission_id",$2,$3,'managed_project_root_create',$4,'pending'
          FROM "demo_showcase_copies" c WHERE c."copy_id"=$1
          ON CONFLICT ("copy_id") DO NOTHING`, [copyId, ownerId, row.target_project_id, claimToken]);
      } else if (phase === 'root_pending' && rootReceipt === 'absent') {
        await manager.query(`UPDATE "demo_copy_effect_receipts"
          SET "claim_token"=$2, "outcome"='pending', "completed_at"=NULL, "updated_at"=clock_timestamp()
          WHERE "copy_id"=$1 AND "outcome"='absent'`, [copyId, claimToken]);
      }
      return { row: claimed, claimToken, snapshot: version.snapshot, files: version.files };
    });
  }

  private async cloneRows(copyId: string, ownerId: string, claimToken: string, projectId: string, snapshot: CurrentShowcaseDto, idMap: CopyIdMap): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockCopy(manager, copyId, ownerId);
      if (!locked || locked.copy.claim_token !== claimToken || !locked.owner_active || locked.admission_status !== 'ready') throw storageUnavailable();
      if (locked.copy.phase === 'database_created' || locked.copy.phase === 'files_pending') return;
      const maxGrowth = BigInt(this.limits?.maxSnapshotBytes ?? 1) * 2n + 1_048_576n;
      await this.quota.runDatabaseMutation(manager, { ownerId, maximumGrowthBytes: maxGrowth }, async () => {
        for (let position = 0; position < snapshot.tasks.length; position += 1) {
          const task = snapshot.tasks[position]!;
          const targetId = idMap.tasks[task.id];
          if (!isUuid(targetId)) throw storageUnavailable();
          const subtasks = task.checklist.map((item) => {
            const id = idMap.checklists[item.id];
            if (!isUuid(id)) throw storageUnavailable();
            return { id, title: item.title, completed: item.completed };
          });
          await manager.query(`
            INSERT INTO "project_tasks" ("id", "owner_id", "project_id", "title", "details", "status", "position", "version", "source_kind", "source_suggestion_id", "idempotency_key", "request_fingerprint", "idempotency_snapshot", "completed_at", "importance", "deadline", "subtasks")
            VALUES ($1,$2,$3,$4,$5,$6,$7,1,'user',NULL,NULL,NULL,NULL,
              CASE WHEN $11::boolean THEN clock_timestamp() ELSE NULL END,
              $8,$9::date,$10::jsonb)
          `, [targetId, ownerId, projectId, task.title, task.details, task.status, position, task.importance, task.deadline, JSON.stringify(subtasks), task.status === 'done']);
        }
        for (const fact of snapshot.facts) {
          const targetId = idMap.facts[fact.id];
          if (!isUuid(targetId)) throw storageUnavailable();
          await manager.query(`
            INSERT INTO "project_facts" ("id", "owner_id", "project_id", "fact_key", "title", "content", "source_kind", "version", "verified_at")
            VALUES ($1,$2,$3,$4,$5,$6,'user',1,NULL)
          `, [targetId, ownerId, projectId, `showcase-${targetId}`, fact.title, fact.content]);
        }
        for (const skill of snapshot.skills) {
          const targetId = idMap.skills[skill.id];
          if (!isUuid(targetId)) throw storageUnavailable();
          await manager.query(`
            INSERT INTO "skills" ("id", "owner_id", "workspace_id")
            VALUES ($1, $2, $3)
          `, [targetId, ownerId, projectId]);
          await manager.query(`
            INSERT INTO "skill_revisions" ("owner_id", "skill_id", "version", "title", "instructions", "enabled", "declared_tools")
            VALUES ($1, $2, 1, $3, $4, true, $5::jsonb)
          `, [ownerId, targetId, skill.title, skill.instructions, JSON.stringify(skill.declaredTools)]);
        }
        const references = await this.contentAccounting.scanDatabaseContent(manager, ownerId);
        return { result: undefined, references: references.map((reference) => ({ reference, nextBytes: reference.bytes, nextSha256: null })) };
      });
      await manager.query(`UPDATE "demo_showcase_copies" SET "phase"='database_created', "updated_at"=clock_timestamp() WHERE "copy_id"=$1 AND "claim_token"=$2`, [copyId, claimToken]);
    });
  }

  private async copyFile(copyId: string, ownerId: string, projectId: string, file: ShowcaseStoredVersion['files'][number]): Promise<void> {
    const access = await this.fileAccess.authorizeMutation({ ownerId, projectId });
    const plan: StorageFileReferencePlan = {
      kind: 'project_file', resourceKey: access.rootKey, copyKey: file.name, projectId,
      rootKey: access.rootKey, relativeKey: file.name, expectedPriorBytes: null, expectedPriorSha256: null,
      intendedBytes: BigInt(file.byteLength), intendedSha256: file.sha256
    };
    const identity = {
      ownerId, operationKey: `showcase-copy:${copyId}:${file.id}`, projectId, rootKey: access.rootKey,
      targetKey: file.name, changes: [plan]
    };
    const command: StorageFileOperationCommand = { ...identity, fingerprint: storageFileOperationFingerprint(identity) };
    const result = await this.fileMutations.execute(command, access.resolveTrustedScope, async (trusted) => {
      const scope = trustedProjectScope(trusted, access);
      await this.fileGateway.ensureParentDirectories(scope, file.name);
      const written = await this.fileGateway.write(scope, { path: file.name, bytes: file.bytes, expectedHash: null });
      const verified = await this.fileGateway.download(scope, file.name);
      if (written.hash !== file.sha256 || verified.hash !== file.sha256 || !verified.bytes.equals(file.bytes)) {
        throw new Error('The private file copy could not be verified.');
      }
      return { result: written.hash, changes: [verifiedChange(plan, verified.bytes.length, verified.hash)] };
    });
    if (result.state === 'settled') {
      if (result.changes.length !== 1 || result.changes[0]?.sha256 !== file.sha256 || result.changes[0]?.bytes !== BigInt(file.byteLength)) {
        throw storageUnavailable();
      }
    }
  }

  private async finish(copyId: string, ownerId: string, claimToken: string, projectId: string, snapshot: CurrentShowcaseDto, files: ShowcaseStoredVersion['files']): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockCopy(manager, copyId, ownerId);
      if (!locked || locked.copy.claim_token !== claimToken || locked.copy.pinned_version_id === null
        || locked.admission_status !== 'ready' || !locked.owner_active) throw storageUnavailable();
      const projectRows = rows<{ readonly relative_root: string | null; readonly relative_root_key: string | null; readonly storage_kind: string | null }>(await manager.query(
        'SELECT "relative_root", "relative_root_key", "storage_kind" FROM "projects" WHERE "owner_id"=$1 AND "id"=$2 AND "status"=\'active\' FOR SHARE', [ownerId, projectId]
      ));
      const project = projectRows[0];
      if (!project) throw storageUnavailable();
      const policy = rows<{ readonly id: string }>(await manager.query(
        `SELECT "id" FROM "assistant_scope_policies" WHERE "owner_id"=$1 AND "scope_kind"='project' AND "project_id"=$2 AND "enabled"=true AND "revoked_at" IS NULL LIMIT 1`, [ownerId, projectId]
      ));
      const orderState = rows<{ readonly project_id: string }>(await manager.query('SELECT "project_id" FROM "project_task_order_states" WHERE "owner_id"=$1 AND "project_id"=$2 LIMIT 1', [ownerId, projectId]));
      const taskCount = rows<{ readonly count: string | number }>(await manager.query('SELECT count(*) AS "count" FROM "project_tasks" WHERE "owner_id"=$1 AND "project_id"=$2', [ownerId, projectId]));
      const factCount = rows<{ readonly count: string | number }>(await manager.query('SELECT count(*) AS "count" FROM "project_facts" WHERE "owner_id"=$1 AND "project_id"=$2', [ownerId, projectId]));
      const skillCount = rows<{ readonly count: string | number }>(await manager.query('SELECT count(*) AS "count" FROM "skills" WHERE "owner_id"=$1 AND "workspace_id"=$2 AND "deleted_at" IS NULL', [ownerId, projectId]));
      if (!policy[0] || !orderState[0] || Number(taskCount[0]?.count) !== snapshot.tasks.length
        || Number(factCount[0]?.count) !== snapshot.facts.length || Number(skillCount[0]?.count) !== snapshot.skills.length) throw storageUnavailable();
      if (files.length > 0 && (!project.relative_root || project.storage_kind !== 'managed' || project.relative_root !== `projects/${projectId}`)) throw storageUnavailable();
      for (const file of files) {
        const ref = rows<{ readonly byte_count: string; readonly sha256: string | null }>(await manager.query(`
          SELECT "byte_count", "sha256" FROM "storage_resource_references"
          WHERE "owner_id"=$1 AND "resource_kind"='project_file' AND "resource_key"=$2 AND "copy_key"=$3 AND "project_id"=$4
        `, [ownerId, project.relative_root_key, file.name, projectId]))[0];
        if (!ref || BigInt(ref.byte_count) !== BigInt(file.byteLength) || ref.sha256 !== file.sha256) throw storageUnavailable();
      }
      const unknown = rows<{ readonly id: string }>(await manager.query(
        `SELECT "id" FROM "storage_filesystem_reservations" WHERE "owner_id"=$1 AND "status" IN ('pending','unknown') LIMIT 1`, [ownerId]
      ));
      if (unknown.length > 0) throw storageUnavailable();
      const workspaceMode = files.length > 0 ? 'file_backed' : 'planning';
      await manager.query(`
        UPDATE "demo_showcase_copies" SET "state"='ready', "phase"='complete', "pinned_version_id"=NULL,
          "claim_token"=NULL, "claim_expires_at"=NULL, "retry_allowed"=false, "failure_code"=NULL,
          "workspace_mode"=$2, "file_access"=$3, "updated_at"=clock_timestamp()
        WHERE "copy_id"=$1 AND "claim_token"=$4
      `, [copyId, workspaceMode, files.length > 0, claimToken]);
    });
  }

  private async advance(copyId: string, ownerId: string, claimToken: string, phase: CopyPhase): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockCopy(manager, copyId, ownerId);
      if (!locked || locked.copy.claim_token !== claimToken || !locked.owner_active || locked.admission_status !== 'ready') throw storageUnavailable();
      await manager.query(`UPDATE "demo_showcase_copies" SET "phase"=$3, "claim_expires_at"=clock_timestamp() + interval '5 minutes', "updated_at"=clock_timestamp() WHERE "copy_id"=$1 AND "claim_token"=$2`, [copyId, claimToken, phase]);
    });
  }

  private async finishRootEffect(
    copyId: string,
    ownerId: string,
    projectId: string,
    claimToken: string,
    outcome: 'absent' | 'verified' | 'unknown'
  ): Promise<void> {
    await this.dataSource.query(`UPDATE "demo_copy_effect_receipts"
      SET "outcome"=$5, "completed_at"=clock_timestamp(), "updated_at"=clock_timestamp()
      WHERE "copy_id"=$1 AND "owner_id"=$2 AND "project_id"=$3 AND "claim_token"=$4 AND "outcome"='pending'`,
    [copyId, ownerId, projectId, claimToken, outcome]);
  }

  private async fail(copyId: string, ownerId: string, claimToken: string | null, code: 'quota' | 'storage' | 'unknown_side_effect' | 'expired', retryAllowed: boolean, unknown: boolean): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockCopy(manager, copyId, ownerId);
      if (!locked || (claimToken && locked.copy.claim_token !== claimToken)) return;
      await manager.query(`
        UPDATE "demo_showcase_copies" SET "state"='failed', "phase"=$2, "claim_token"=NULL, "claim_expires_at"=NULL,
          "retry_allowed"=$3, "failure_code"=$4, "updated_at"=clock_timestamp()
        WHERE "copy_id"=$1
      `, [copyId, unknown ? 'unknown' : locked.copy.phase, retryAllowed, code]);
    });
  }

  private async lockCopy(manager: EntityManager, copyId: string, ownerId: string): Promise<{
    readonly copy: CopyRow; readonly admission_status: string; readonly owner_active: boolean;
    readonly copy_claim_live: boolean;
  } | null> {
    const admissions = rows<{ readonly id: string; readonly status: string }>(await manager.query(
      'SELECT "id", "status" FROM "demo_admissions" WHERE "id"=(SELECT "admission_id" FROM "demo_showcase_copies" WHERE "copy_id"=$1 AND "owner_id"=$2) AND "owner_id"=$2 FOR UPDATE', [copyId, ownerId]
    ));
    if (!admissions[0]) return null;
    const owners = rows<{ readonly id: string; readonly active_now: boolean }>(await manager.query(
      'SELECT "id", ("is_active"=true AND ("expires_at" IS NULL OR "expires_at">clock_timestamp())) AS "active_now" FROM "users" WHERE "id"=$1 FOR UPDATE', [ownerId]
    ));
    if (!owners[0]) return null;
    const copy = rows<CopyRow>(await manager.query(`
      SELECT "copy_id", "owner_id", "pinned_version_id", "target_project_id", "state", "phase", "claim_token",
        "claim_expires_at", "attempts", "retry_allowed", "id_map", "workspace_mode", "file_access",
        ("claim_token" IS NOT NULL AND "claim_expires_at">clock_timestamp()) AS "copy_claim_live"
      FROM "demo_showcase_copies" WHERE "copy_id"=$1 AND "owner_id"=$2 FOR UPDATE
    `, [copyId, ownerId]))[0];
    return copy ? {
      copy,
      admission_status: admissions[0].status,
      owner_active: owners[0].active_now,
      copy_claim_live: (copy as CopyRow & { readonly copy_claim_live?: boolean }).copy_claim_live === true
    } : null;
  }
}

function toDto(row: CopyStatusRow): DemoShowcaseCopyDto {
  const ready = row.state === 'ready' && row.workspace_mode !== null && row.file_access !== null;
  return {
    state: row.state,
    projectId: ready ? row.target_project_id : null,
    retryAllowed: row.retry_allowed,
    workspaceMode: ready ? row.workspace_mode : null,
    capabilities: ready ? { planning: true, fileAccess: row.file_access! } : null
  };
}

function trustedProjectScope(trusted: StorageTrustedFileScope, access: Awaited<ReturnType<TypeOrmProjectFileAccess['authorizeMutation']>>): Awaited<ReturnType<TypeOrmProjectFileAccess['authorizeMutation']>>['scope'] {
  const root = trusted.roots.find((item) => item.rootKey === access.rootKey);
  if (trusted.ownerId !== access.ownerId || trusted.projectId !== access.projectId || trusted.roots.length !== 1 || !root
    || root.locatorProjectId !== access.projectId || root.relativeRoot !== access.scope.relativeRoot || root.storageKind !== 'managed') throw storageUnavailable();
  return access.scope;
}

function verifiedChange(plan: StorageFileReferencePlan, bytes: number, sha256: string): StorageVerifiedFileChange {
  return { kind: plan.kind, resourceKey: plan.resourceKey, copyKey: plan.copyKey, projectId: plan.projectId, rootKey: plan.rootKey,
    relativeKey: plan.relativeKey, bytes: BigInt(bytes), sha256 };
}

function storageUnavailable(): AppError { return new AppError('DEMO_COPY_UNAVAILABLE', 503, 'The private demo copy is unavailable.'); }
function notRetryable(): AppError { return new AppError('DEMO_COPY_NOT_RETRYABLE', 409, 'This demo copy cannot be retried safely.'); }
