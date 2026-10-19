import type { DataSource } from 'typeorm';
import { projectRootOverlapKey, projectRootsOverlap } from '@/modules/projects/domain/project-root-policy';
import { lockStorageRootOwner } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';

import type { StorageTrustedProjectRoot } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { StorageFileOperationScopeRequest, StorageQuotaTransaction } from '@/modules/storage-quotas/repositories/storage-quota-repository';
import type {
  DeleteVerifiedRetainedStorageRootInput,
  IStorageRootMappingRepository,
  RegisterVerifiedRetainedManagedOrphanInput,
  RetainProjectStorageRootInput,
  StorageRootMapping
} from '@/modules/storage-quotas/repositories/storage-root-mapping-repository';

interface StorageRootMappingRow {
  readonly owner_id: string;
  readonly project_id: string | null;
  readonly locator_project_id: string;
  readonly root_key: string;
  readonly storage_kind: 'legacy' | 'managed';
  readonly relative_root: string;
  readonly state: 'active' | 'retained';
}

function mapRow(row: StorageRootMappingRow): StorageRootMapping {
  return {
    ownerId: row.owner_id,
    projectId: row.project_id,
    locatorProjectId: row.locator_project_id,
    rootKey: row.root_key,
    storageKind: row.storage_kind,
    relativeRoot: row.relative_root,
    state: row.state
  };
}

function rows<T>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) throw new Error('The storage root mapping query returned an unexpected result.');
  if (value.length === 2 && Array.isArray(value[0]) && typeof value[1] === 'number') return value[0] as readonly T[];
  return value as readonly T[];
}

/** Resolves only database-persisted owner/project roots; caller paths are never accepted. */
export class TypeOrmStorageRootMappingRepository implements IStorageRootMappingRepository {
  public constructor(private readonly dataSource: DataSource) {}

  public async registerVerifiedRetainedManagedOrphan(
    input: RegisterVerifiedRetainedManagedOrphanInput
  ): Promise<StorageRootMapping> {
    if (!isCanonicalUuid(input.ownerId) || !isCanonicalUuid(input.locatorProjectId)) {
      throw new Error('A managed orphan must use canonical owner and project UUIDs.');
    }
    const relativeRoot = `projects/${input.locatorProjectId}`;
    const rootKey = projectRootOverlapKey(relativeRoot);
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const owners = rows<{ readonly id: string }>(await runner.query(
        'SELECT "id" FROM "users" WHERE "id" = $1 FOR SHARE', [input.ownerId]
      ));
      if (owners.length !== 1) throw new Error('The managed orphan owner is unavailable.');
      const limits = rows<{ readonly owner_id: string }>(await runner.query(
        'SELECT "owner_id" FROM "account_limits" WHERE "owner_id" = $1 FOR UPDATE', [input.ownerId]
      ));
      if (limits.length !== 1) throw new Error('The managed orphan account is unavailable.');
      const totals = rows<{ readonly accounting_state: string }>(await runner.query(
        'SELECT "accounting_state" FROM "storage_account_totals" WHERE "owner_id" = $1 FOR UPDATE', [input.ownerId]
      ));
      if (!totals[0] || !['unavailable', 'reconciling'].includes(totals[0].accounting_state)) {
        throw new Error('Managed orphan registration is allowed only while accounting is unavailable.');
      }
      await lockStorageRootOwner(runner, input.ownerId);

      const duplicateMappings = rows<StorageRootMappingRow>(await runner.query(
        `SELECT "owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state"
         FROM "storage_root_mappings" WHERE "owner_id" = $1 AND ("root_key" = $2 OR "locator_project_id" = $3)
         ORDER BY "root_key" FOR UPDATE`,
        [input.ownerId, rootKey, input.locatorProjectId]
      ));
      if (duplicateMappings.length > 0) {
        const existing = duplicateMappings.length === 1 ? duplicateMappings[0] : undefined;
        if (existing && isExactRetainedManagedOrphan(existing, input.ownerId, input.locatorProjectId, rootKey, relativeRoot)) {
          await runner.commitTransaction();
          return mapRow(existing);
        }
        throw new Error('The managed orphan conflicts with an existing trusted root mapping.');
      }

      const projectIdentity = rows<{ readonly id: string }>(await runner.query(
        'SELECT "id" FROM "projects" WHERE "id" = $1 FOR UPDATE', [input.locatorProjectId]
      ));
      if (projectIdentity.length > 0) throw new Error('The managed orphan conflicts with an existing project.');
      const mappedRoots = rows<{ readonly root_key: string; readonly storage_kind: 'legacy' | 'managed'; readonly relative_root: string }>(await runner.query(
        `SELECT "root_key", "storage_kind", "relative_root" FROM "storage_root_mappings"
         WHERE "owner_id" = $1 ORDER BY "root_key" FOR UPDATE`, [input.ownerId]
      ));
      if (mappedRoots.some((root) => root.root_key === rootKey
        || (root.storage_kind === 'managed' && projectRootsOverlap(relativeRoot, root.relative_root)))) {
        throw new Error('The managed orphan overlaps an existing trusted root.');
      }
      const attachedRoots = rows<{ readonly storage_kind: 'legacy' | 'managed'; readonly relative_root: string }>(await runner.query(
        `SELECT "storage_kind", "relative_root" FROM "projects" WHERE "owner_id" = $1 AND "relative_root" IS NOT NULL
         ORDER BY "id" FOR UPDATE`, [input.ownerId]
      ));
      if (attachedRoots.some((root) => root.storage_kind === 'managed' && projectRootsOverlap(relativeRoot, root.relative_root))) {
        throw new Error('The managed orphan overlaps an attached project root.');
      }

      await runner.query("SELECT set_config('app.storage_retained_orphan_registration', $1, true)",
        [`${input.ownerId}:${input.locatorProjectId}:${rootKey}`]);
      const inserted = rows<StorageRootMappingRow>(await runner.query(
        `INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
         VALUES ($1, NULL, $2, $3, 'managed', $4, 'retained')
         RETURNING "owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state"`,
        [input.ownerId, input.locatorProjectId, rootKey, relativeRoot]
      ));
      if (inserted.length !== 1 || !inserted[0]) throw new Error('The managed orphan mapping was not returned.');
      await runner.commitTransaction();
      return mapRow(inserted[0]);
    } catch (error: unknown) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  public async resolveTrustedScope(
    transaction: StorageQuotaTransaction,
    request: StorageFileOperationScopeRequest
  ): Promise<{
    readonly ownerId: string;
    readonly projectId: string | null;
    readonly roots: readonly StorageTrustedProjectRoot[];
  }> {
    const rootKeys = [...new Set(request.rootKeys)];
    if (rootKeys.length === 0 || rootKeys.length !== request.rootKeys.length) {
      throw new Error('The trusted storage root scope is invalid.');
    }
    const projectPredicate = request.projectId === null
      ? 'm."state" = \'retained\' AND m."project_id" IS NULL'
      : 'm."state" = \'active\' AND m."project_id" = $2';
    const projectJoin = request.projectId === null
      ? ''
      : 'JOIN "projects" p ON p."owner_id" = m."owner_id" AND p."id" = m."project_id" AND p."relative_root_key" = m."root_key" AND p."relative_root" = m."relative_root" AND p."storage_kind" = m."storage_kind"';
    const rootParameter = request.projectId === null ? 2 : 3;
    const found = rows<StorageRootMappingRow>(await transaction.query(
      `SELECT m."owner_id", m."project_id", m."locator_project_id", m."root_key", m."storage_kind", m."relative_root", m."state"
       FROM "storage_root_mappings" m
       ${projectJoin}
       WHERE m."owner_id" = $1 AND ${projectPredicate} AND m."root_key" = ANY($${rootParameter}::text[])
       ORDER BY m."root_key" FOR SHARE OF m${request.projectId === null ? '' : ', p'}`,
      request.projectId === null
        ? [request.ownerId, rootKeys]
        : [request.ownerId, request.projectId, rootKeys]
    ));
    if (found.length !== rootKeys.length || found.some((row) => row.owner_id !== request.ownerId)) {
      throw new Error('A trusted storage root is unavailable.');
    }
    const foundKeys = new Set(found.map((row) => row.root_key));
    if (rootKeys.some((rootKey) => !foundKeys.has(rootKey))) throw new Error('A trusted storage root is unavailable.');
    return {
      ownerId: request.ownerId,
      projectId: request.projectId,
      roots: found.map((row) => ({
        ownerId: row.owner_id,
        projectId: row.project_id,
        locatorProjectId: row.locator_project_id,
        rootKey: row.root_key,
        storageKind: row.storage_kind,
        relativeRoot: row.relative_root
      }))
    };
  }

  public async listMappings(ownerId?: string): Promise<readonly StorageRootMapping[]> {
    const result = ownerId === undefined
      ? await this.dataSource.query(
        `SELECT "owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state"
         FROM "storage_root_mappings" ORDER BY "owner_id", "root_key"`
      )
      : await this.dataSource.query(
        `SELECT "owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state"
         FROM "storage_root_mappings" WHERE "owner_id" = $1 ORDER BY "root_key"`,
        [ownerId]
      );
    return rows<StorageRootMappingRow>(result).map(mapRow);
  }

  public async retainProjectRoot(
    transaction: StorageQuotaTransaction,
    input: RetainProjectStorageRootInput
  ): Promise<StorageRootMapping> {
    const result = rows<StorageRootMappingRow>(await transaction.query(
      `UPDATE "storage_root_mappings" SET "project_id" = NULL, "state" = 'retained', "updated_at" = now()
       WHERE "owner_id" = $1 AND "project_id" = $2 AND "state" = 'active'
       RETURNING "owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state"`,
      [input.ownerId, input.projectId]
    ));
    if (result.length !== 1 || result[0] === undefined) throw new Error('The project storage root mapping is unavailable.');
    return mapRow(result[0]);
  }

  public async deleteVerifiedRetained(
    transaction: StorageQuotaTransaction,
    input: DeleteVerifiedRetainedStorageRootInput
  ): Promise<void> {
    const blockers = rows<{ readonly has_references: boolean; readonly has_reservations: boolean }>(await transaction.query(
      `SELECT EXISTS (
         SELECT 1 FROM "storage_resource_references" WHERE "owner_id" = $1 AND "root_key" = $2
       ) AS "has_references",
       EXISTS (
         SELECT 1 FROM "storage_filesystem_reservations" WHERE "owner_id" = $1 AND "root_key" = $2 AND "status" IN ('pending', 'unknown')
       ) AS "has_reservations"`,
      [input.ownerId, input.rootKey]
    ));
    if (blockers[0]?.has_references || blockers[0]?.has_reservations) {
      throw new Error('A retained storage root cannot be released while content references or unresolved operations remain.');
    }
    await transaction.query("SELECT set_config('app.storage_root_removal_verified', $1, true)", [`${input.ownerId}:${input.rootKey}`]);
    const result = await transaction.query(
      `DELETE FROM "storage_root_mappings" WHERE "owner_id" = $1 AND "root_key" = $2 AND "state" = 'retained' AND "project_id" IS NULL RETURNING "owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state"`,
      [input.ownerId, input.rootKey]
    );
    const deleted = rows<StorageRootMappingRow>(result);
    if (deleted.length !== 1) throw new Error('The retained storage root mapping is unavailable.');
  }
}

function isCanonicalUuid(value: string): boolean {
  return value === value.toLowerCase()
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isExactRetainedManagedOrphan(
  row: StorageRootMappingRow,
  ownerId: string,
  locatorProjectId: string,
  rootKey: string,
  relativeRoot: string
): boolean {
  return row.owner_id === ownerId && row.project_id === null && row.locator_project_id === locatorProjectId
    && row.root_key === rootKey && row.storage_kind === 'managed' && row.relative_root === relativeRoot && row.state === 'retained';
}
