import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DataSource } from 'typeorm';

import type { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import type { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import type { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import { projectRootOverlapKey } from '@/modules/projects/domain/project-root-policy';
import { recoveryReferenceIdentity, StorageQuotaRootScanner, type TrustedStorageRoot } from '@/infrastructure/workspace/storage-quota-reconciliation';
import type { IWorkspaceBoundary, ManagedNamespaceInventory } from '@/modules/projects/repositories/workspace-boundary';
import type { StorageFileReferencePlan, StorageResourceReference, StorageUnresolvedFileOperation, StorageVerifiedFileChange } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { StorageRootMapping } from '@/modules/storage-quotas/repositories/storage-root-mapping-repository';

interface OwnerRow { readonly id: string }
interface UsageRow { readonly used_bytes: string; readonly reserved_bytes: string }
interface StoredReferenceRow {
  readonly resource_kind: StorageResourceReference['kind'];
  readonly resource_key: string;
  readonly copy_key: string;
  readonly project_id: string | null;
  readonly root_key: string | null;
  readonly relative_key: string | null;
  readonly byte_count: string;
  readonly sha256: string | null;
}
interface RunRow { readonly owner_id: string; readonly project_id: string; readonly run_id: string }
interface CheckpointRow extends RunRow { readonly backup_checkpoints: unknown }
interface RemovalJobRow { readonly owner_id: string; readonly project_id: string; readonly run_ids: unknown }

interface RunIdentity { readonly ownerId: string; readonly projectId: string }
interface ProjectRootRow {
  readonly id: string;
  readonly owner_id: string;
  readonly relative_root: string | null;
  readonly relative_root_key: string | null;
  readonly storage_kind: 'legacy' | 'managed' | null;
}

export interface StorageQuotaStartupReconciliationResult {
  readonly readyOwnerIds: readonly string[];
  readonly unavailableOwnerIds: readonly string[];
}

/** Rebuilds exact retained-content references before requests are admitted. */
export class StorageQuotaStartupReconciler {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly quotaRepository: TypeOrmStorageQuotaRepository,
    private readonly rootMappings: TypeOrmStorageRootMappingRepository,
    private readonly contentAccounting: TypeOrmStorageContentAccounting,
    private readonly workspaceBoundary: IWorkspaceBoundary,
    private readonly recoveryRoot: string,
    private readonly scanner = new StorageQuotaRootScanner()
  ) {}

  public async reconcile(): Promise<StorageQuotaStartupReconciliationResult> {
    const owners = queryRows<OwnerRow>(await this.dataSource.query('SELECT "id" FROM "users" ORDER BY "id"'))
      .map((row) => row.id);
    const unavailable = new Set<string>();
    for (const ownerId of owners) {
      try {
        // This committed state transition blocks new content writes while physical roots are scanned.
        await this.quotaRepository.markAccountUnavailable(ownerId);
      } catch {
        unavailable.add(ownerId);
      }
    }

    const mappings = [...await this.rootMappings.listMappings()];
    const projectRows = queryRows<ProjectRootRow>(await this.dataSource.query(
      'SELECT "id", "owner_id", "relative_root", "relative_root_key", "storage_kind" FROM "projects" ORDER BY "owner_id", "id"'
    ));
    const ownersSet = new Set(owners);
    const projectsById = new Map(projectRows.map((row) => [row.id, row]));
    const namespace = await this.inspectManagedNamespace(ownersSet, mappings, unavailable);
    this.validatePersistedRootMappings(mappings, projectRows, unavailable);
    if (namespace && namespace.configured && !namespace.unattributableEntries) {
      await this.registerManagedOrphans(namespace, ownersSet, projectsById, mappings, unavailable);
    }
    if (namespace?.unattributableEntries) {
      for (const ownerId of owners) unavailable.add(ownerId);
    }
    const runIdentities = await this.loadRunIdentities();
    const removalJobs = queryRows<RemovalJobRow>(await this.dataSource.query(
      'SELECT "owner_id", "project_id", "run_ids" FROM "project_removal_jobs" ORDER BY "owner_id", "project_id"'
    ));
    const jobsByOwner = new Set(removalJobs.map((row) => row.owner_id));
    for (const ownerId of jobsByOwner) unavailable.add(ownerId);

    let recoveryEntries: readonly string[] = [];
    let recoveryRootExists = false;
    try {
      const rootStat = await fs.lstat(this.recoveryRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe recovery root');
      const canonicalRoot = await fs.realpath(this.recoveryRoot);
      if (path.resolve(canonicalRoot) !== path.resolve(this.recoveryRoot)) throw new Error('non-canonical recovery root');
      recoveryEntries = await fs.readdir(this.recoveryRoot);
      recoveryRootExists = true;
    } catch (error: unknown) {
      if (!isMissing(error)) {
        for (const ownerId of owners) unavailable.add(ownerId);
      }
    }

    const recoveryDirectories = new Map<string, { readonly name: string; readonly identity: RunIdentity }>();
    for (const entry of recoveryEntries) {
      const runId = recoveryRunId(entry);
      const identity = runId ? runIdentities.get(runId) : undefined;
      if (!runId || !identity || recoveryDirectories.has(runId)) {
        // Unattributed recovery data cannot safely be assigned to an account.
        for (const ownerId of owners) unavailable.add(ownerId);
        continue;
      }
      let stats;
      try { stats = await fs.lstat(path.join(this.recoveryRoot, entry)); } catch { unavailable.add(identity.ownerId); continue; }
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        unavailable.add(identity.ownerId);
        continue;
      }
      recoveryDirectories.set(runId, { name: entry, identity });
    }

    const rootsByOwner = new Map<string, TrustedStorageRoot[]>();
    const physicalRoots: { ownerId: string; absolutePath: string }[] = [];
    const projectPhysicalRoots: { ownerId: string; absolutePath: string }[] = [];
    for (const mapping of mappings) {
      try {
        const resolved = await this.resolveMapping(mapping);
        const root: TrustedStorageRoot = {
          ownerId: mapping.ownerId,
          projectId: mapping.projectId,
          rootKey: mapping.rootKey,
          absolutePath: resolved,
          classifyFile: () => mapping.state === 'retained' ? 'retained_root' : 'project_file'
        };
        const ownerRoots = rootsByOwner.get(mapping.ownerId) ?? [];
        ownerRoots.push(root);
        rootsByOwner.set(mapping.ownerId, ownerRoots);
        physicalRoots.push({ ownerId: mapping.ownerId, absolutePath: resolved });
        projectPhysicalRoots.push({ ownerId: mapping.ownerId, absolutePath: resolved });
      } catch {
        unavailable.add(mapping.ownerId);
      }
    }

    if (recoveryRootExists) {
      for (const ownerId of owners) {
        for (const { identity, name } of recoveryDirectories.values()) {
          if (identity.ownerId !== ownerId) continue;
          const runId = recoveryRunId(name);
          if (!runId) { unavailable.add(ownerId); continue; }
          const prefix = name;
          const root: TrustedStorageRoot = {
            ownerId,
            projectId: identity.projectId,
            rootKey: 'recovery-v1',
            absolutePath: path.join(this.recoveryRoot, name),
            classifyFile: () => 'recovery_file',
            referenceForFile: (physicalRelativeKey) => recoveryReferenceIdentity(`${prefix}/${physicalRelativeKey}`, identity.projectId)
          };
          const ownerRoots = rootsByOwner.get(ownerId) ?? [];
          ownerRoots.push(root);
          rootsByOwner.set(ownerId, ownerRoots);
          physicalRoots.push({ ownerId, absolutePath: root.absolutePath });
        }
      }
    }
    markOverlappingRootsUnavailable(physicalRoots, unavailable);
    if (recoveryRootExists) {
      for (const root of projectPhysicalRoots) {
        if (isSameOrNestedPath(this.recoveryRoot, root.absolutePath)
          || isSameOrNestedPath(root.absolutePath, this.recoveryRoot)) {
          unavailable.add(root.ownerId);
        }
      }
    }

    const ready: string[] = [];
    for (const ownerId of owners) {
      if (unavailable.has(ownerId)) continue;
      try {
        const previous = await this.readStoredReferences(ownerId);
        const unresolved = await this.quotaRepository.listUnresolvedFileOperations(ownerId);
        const scannedFiles = await this.scanner.scan(rootsByOwner.get(ownerId) ?? []);
        const fileMap = uniqueReferenceMap(scannedFiles);
        const plannedReferences = new Set(unresolved.flatMap((operation) => operation.command.changes.map(planKey)));

        await this.validatePriorFileInventory(previous, fileMap, plannedReferences);
        await this.validateRecoveryInventory(ownerId, previous, fileMap, plannedReferences);
        await this.resolveUnfinishedOperations(ownerId, unresolved, fileMap, mappings);

        const stillUnresolved = await this.quotaRepository.listUnresolvedFileOperations(ownerId);
        const totals = queryRows<UsageRow>(await this.dataSource.query(
          'SELECT "used_bytes", "reserved_bytes" FROM "storage_account_totals" WHERE "owner_id" = $1', [ownerId]
        ))[0];
        if (stillUnresolved.length > 0 || !totals || BigInt(totals.reserved_bytes) !== 0n) {
          unavailable.add(ownerId);
          continue;
        }

        const databaseReferences = await this.contentAccounting.scanDatabaseContent(this.dataSource, ownerId);
        const references = [...databaseReferences, ...scannedFiles];
        uniqueReferenceMap(references);
        await this.quotaRepository.reconcileReferences(ownerId, references);
        ready.push(ownerId);
      } catch {
        unavailable.add(ownerId);
        try { await this.quotaRepository.markAccountUnavailable(ownerId); } catch { /* Keep startup fail-closed. */ }
      }
    }

    return {
      readyOwnerIds: ready,
      unavailableOwnerIds: owners.filter((ownerId) => !ready.includes(ownerId))
    };
  }

  private async resolveMapping(mapping: StorageRootMapping): Promise<string> {
    if (!this.workspaceBoundary.resolveProjectRoot) throw new Error('workspace root resolver unavailable');
    const resolved = await this.workspaceBoundary.resolveProjectRoot({
      ownerId: mapping.ownerId,
      projectId: mapping.locatorProjectId,
      storageKind: mapping.storageKind,
      relativeRoot: mapping.relativeRoot
    });
    return resolved.canonicalProjectRoot;
  }

  private async inspectManagedNamespace(
    owners: ReadonlySet<string>,
    mappings: readonly StorageRootMapping[],
    unavailable: Set<string>
  ): Promise<ManagedNamespaceInventory | null> {
    if (!this.workspaceBoundary.inspectManagedNamespace) {
      for (const mapping of mappings) {
        if (mapping.storageKind === 'managed') unavailable.add(mapping.ownerId);
      }
      return null;
    }
    try {
      const inventory = await this.workspaceBoundary.inspectManagedNamespace();
      if (inventory.owners.some((entry) => !owners.has(entry.ownerId))) {
        for (const ownerId of owners) unavailable.add(ownerId);
      }
      return inventory;
    } catch {
      for (const ownerId of owners) unavailable.add(ownerId);
      return null;
    }
  }

  private validatePersistedRootMappings(
    mappings: readonly StorageRootMapping[],
    projects: readonly ProjectRootRow[],
    unavailable: Set<string>
  ): void {
    const mappingByProject = new Map(mappings.filter((mapping) => mapping.projectId !== null)
      .map((mapping) => [`${mapping.ownerId}:${mapping.projectId}`, mapping]));
    for (const project of projects) {
      if (project.relative_root === null) continue;
      const mapping = mappingByProject.get(`${project.owner_id}:${project.id}`);
      if (!mapping || mapping.state !== 'active' || mapping.relativeRoot !== project.relative_root
        || mapping.rootKey !== project.relative_root_key || mapping.storageKind !== project.storage_kind) {
        unavailable.add(project.owner_id);
      }
    }
    for (const mapping of mappings) {
      if (mapping.state === 'retained') {
        if (projects.some((project) => project.id === mapping.locatorProjectId)) unavailable.add(mapping.ownerId);
        continue;
      }
      const project = projectsByOwnerAndId(projects, mapping.ownerId, mapping.projectId);
      if (!project || project.relative_root !== mapping.relativeRoot || project.relative_root_key !== mapping.rootKey
        || project.storage_kind !== mapping.storageKind) {
        unavailable.add(mapping.ownerId);
      }
    }
  }

  private async registerManagedOrphans(
    inventory: ManagedNamespaceInventory,
    knownOwners: ReadonlySet<string>,
    projects: ReadonlyMap<string, ProjectRootRow>,
    mappings: StorageRootMapping[],
    unavailable: Set<string>
  ): Promise<void> {
    if (!inventory.configured || inventory.unattributableEntries) return;
    for (const namespace of inventory.owners) {
      if (!knownOwners.has(namespace.ownerId)) {
        for (const ownerId of knownOwners) unavailable.add(ownerId);
        continue;
      }
      if (namespace.unsafe || unavailable.has(namespace.ownerId)) {
        unavailable.add(namespace.ownerId);
        continue;
      }
      for (const projectId of namespace.projectIds) {
        const relativeRoot = `projects/${projectId}`;
        const rootKey = projectRootOverlapKey(relativeRoot);
        const matching = mappings.filter((mapping) => mapping.ownerId === namespace.ownerId
          && (mapping.rootKey === rootKey || mapping.locatorProjectId === projectId));
        if (matching.length > 0) {
          const mapping = matching.length === 1 ? matching[0] : undefined;
          if (!mapping || mapping.locatorProjectId !== projectId || mapping.rootKey !== rootKey
            || mapping.storageKind !== 'managed' || mapping.relativeRoot !== relativeRoot) {
            unavailable.add(namespace.ownerId);
          }
          continue;
        }
        if (projects.has(projectId)) {
          unavailable.add(namespace.ownerId);
          continue;
        }
        try {
          const mapping = await this.rootMappings.registerVerifiedRetainedManagedOrphan({
            ownerId: namespace.ownerId,
            locatorProjectId: projectId
          });
          mappings.push(mapping);
        } catch {
          unavailable.add(namespace.ownerId);
        }
      }
    }
  }

  private async loadRunIdentities(): Promise<Map<string, RunIdentity>> {
    const identities = new Map<string, RunIdentity>();
    const rows = queryRows<RunRow>(await this.dataSource.query(
      'SELECT "owner_id", "project_id", "id" AS "run_id" FROM "ai_runs" ORDER BY "id"'
    ));
    for (const row of rows) addRunIdentity(identities, row.run_id, row.owner_id, row.project_id);

    const changeSets = queryRows<CheckpointRow>(await this.dataSource.query(
      'SELECT "owner_id", "project_id", "run_id", "backup_checkpoints" FROM "ai_run_change_sets" ORDER BY "run_id"'
    ));
    for (const row of changeSets) {
      addRunIdentity(identities, row.run_id, row.owner_id, row.project_id);
      for (const reference of checkpointReferences(row.backup_checkpoints)) {
        if (!recoveryReferenceIdentity(reference, row.project_id)) throw new Error('invalid persisted recovery checkpoint');
      }
    }

    const recoveryReferences = queryRows<{ owner_id: string; project_id: string; resource_key: string }>(await this.dataSource.query(
      `SELECT DISTINCT "owner_id", "project_id", "resource_key" FROM "storage_resource_references"
       WHERE "resource_kind" = 'recovery_file' AND "root_key" = 'recovery-v1'`
    ));
    for (const row of recoveryReferences) {
      if (!row.project_id) throw new Error('recovery reference without a project');
      addRunIdentity(identities, row.resource_key, row.owner_id, row.project_id);
    }

    const jobs = queryRows<RemovalJobRow>(await this.dataSource.query(
      'SELECT "owner_id", "project_id", "run_ids" FROM "project_removal_jobs" ORDER BY "owner_id", "project_id"'
    ));
    for (const job of jobs) {
      for (const runId of parseRunIds(job.run_ids)) addRunIdentity(identities, runId, job.owner_id, job.project_id);
    }
    return identities;
  }

  private async readStoredReferences(ownerId: string): Promise<readonly StorageResourceReference[]> {
    const rows = queryRows<StoredReferenceRow>(await this.dataSource.query(
      `SELECT "resource_kind", "resource_key", "copy_key", "project_id", "root_key", "relative_key", "byte_count", "sha256"
       FROM "storage_resource_references" WHERE "owner_id" = $1 ORDER BY "resource_kind", "resource_key", "copy_key"`, [ownerId]
    ));
    return rows.map((row) => ({
      ownerId,
      kind: row.resource_kind,
      resourceKey: row.resource_key,
      copyKey: row.copy_key,
      projectId: row.project_id,
      rootKey: row.root_key,
      relativeKey: row.relative_key,
      bytes: BigInt(row.byte_count),
      sha256: row.sha256
    }));
  }

  private async validateRecoveryInventory(
    ownerId: string,
    previous: readonly StorageResourceReference[],
    scanned: ReadonlyMap<string, StorageResourceReference>,
    plannedReferences: ReadonlySet<string>
  ): Promise<void> {
    const required = new Map<string, string>();
    for (const reference of previous) {
      if (reference.kind === 'recovery_file' && !plannedReferences.has(referenceKey(reference))) {
        required.set(referenceKey(reference), reference.projectId ?? '');
      }
    }
    const checkpointRows = queryRows<CheckpointRow>(await this.dataSource.query(
      'SELECT "owner_id", "project_id", "run_id", "backup_checkpoints" FROM "ai_run_change_sets" WHERE "owner_id" = $1', [ownerId]
    ));
    for (const row of checkpointRows) {
      for (const reference of checkpointReferences(row.backup_checkpoints)) {
        const identity = recoveryReferenceIdentity(reference, row.project_id);
        if (!identity) throw new Error('invalid persisted recovery checkpoint');
        const key = `${identity.kind}\u0000${identity.resourceKey}\u0000${identity.copyKey}`;
        if (!plannedReferences.has(key)) required.set(key, row.project_id);
      }
    }
    for (const [key, projectId] of required) {
      const found = scanned.get(key);
      if (!found || found.projectId !== projectId) throw new Error('a persisted recovery copy is not present in its trusted root');
    }
  }

  private async validatePriorFileInventory(
    previous: readonly StorageResourceReference[],
    scanned: ReadonlyMap<string, StorageResourceReference>,
    plannedReferences: ReadonlySet<string>
  ): Promise<void> {
    for (const reference of previous) {
      if (reference.kind === 'database_content' || plannedReferences.has(referenceKey(reference))) continue;
      const found = scanned.get(referenceKey(reference));
      if (!found || found.rootKey !== reference.rootKey || found.relativeKey !== reference.relativeKey
        || found.projectId !== reference.projectId || found.bytes !== reference.bytes || found.sha256 !== reference.sha256) {
        throw new Error('A previously accounted filesystem copy is missing or changed outside a durable operation.');
      }
    }
  }

  private async resolveUnfinishedOperations(
    ownerId: string,
    operations: readonly StorageUnresolvedFileOperation[],
    scanned: ReadonlyMap<string, StorageResourceReference>,
    mappings: readonly StorageRootMapping[]
  ): Promise<void> {
    for (const operation of operations) {
      const actual: StorageVerifiedFileChange[] = [];
      let matchesPrior = true;
      for (const plan of operation.command.changes) {
        validatePlanRoot(ownerId, plan, mappings);
        const found = scanned.get(planKey(plan));
        if (found && (found.rootKey !== plan.rootKey || found.relativeKey !== plan.relativeKey || found.projectId !== plan.projectId)) {
          throw new Error('A reserved file location is associated with another trusted root.');
        }
        const bytes = found?.bytes ?? null;
        const sha256 = found?.sha256 ?? null;
        if (bytes !== plan.expectedPriorBytes || sha256 !== plan.expectedPriorSha256) matchesPrior = false;
        actual.push({
          kind: plan.kind,
          resourceKey: plan.resourceKey,
          copyKey: plan.copyKey,
          projectId: plan.projectId,
          rootKey: plan.rootKey,
          relativeKey: plan.relativeKey,
          bytes,
          sha256
        });
      }
      if (matchesPrior) {
        await this.quotaRepository.releaseFileOperationWithNoSideEffect(ownerId, operation.operationId);
      } else {
        await this.quotaRepository.settleFileOperation(ownerId, operation.operationId, actual);
      }
    }
  }
}

function queryRows<T>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) throw new Error('Storage reconciliation query returned an invalid result.');
  if (value.length === 2 && Array.isArray(value[0]) && typeof value[1] === 'number') return value[0] as readonly T[];
  return value as readonly T[];
}

function projectsByOwnerAndId(projects: readonly ProjectRootRow[], ownerId: string, projectId: string | null): ProjectRootRow | undefined {
  if (projectId === null) return undefined;
  return projects.find((project) => project.owner_id === ownerId && project.id === projectId);
}

function addRunIdentity(target: Map<string, RunIdentity>, runId: string, ownerId: string, projectId: string): void {
  const normalized = runId.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new Error('A persisted recovery run identity is invalid.');
  }
  const existing = target.get(normalized);
  if (existing && (existing.ownerId !== ownerId || existing.projectId !== projectId)) {
    throw new Error('A recovery run identity has conflicting owners.');
  }
  target.set(normalized, { ownerId, projectId });
}

function parseRunIds(value: unknown): readonly string[] {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error('A project removal job has invalid run identities.');
  return parsed as string[];
}

function checkpointReferences(value: unknown): readonly string[] {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  if (!Array.isArray(parsed)) throw new Error('A persisted backup checkpoint list is invalid.');
  const references: string[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('A persisted backup checkpoint is invalid.');
    const reference = (candidate as Record<string, unknown>).reference;
    if (typeof reference !== 'string') throw new Error('A persisted backup checkpoint reference is invalid.');
    references.push(reference);
  }
  return references;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { throw new Error('Persisted storage JSON is invalid.'); }
}

function recoveryRunId(directoryName: string): string | null {
  const match = /^(?:run-|\.removed-run-)([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(directoryName);
  return match?.[1]?.toLowerCase() ?? null;
}

function referenceKey(reference: StorageResourceReference): string {
  return `${reference.kind}\u0000${reference.resourceKey}\u0000${reference.copyKey}`;
}

function planKey(plan: StorageFileReferencePlan): string {
  return `${plan.kind}\u0000${plan.resourceKey}\u0000${plan.copyKey}`;
}

function uniqueReferenceMap(references: readonly StorageResourceReference[]): Map<string, StorageResourceReference> {
  const result = new Map<string, StorageResourceReference>();
  for (const reference of references) {
    const key = referenceKey(reference);
    if (result.has(key)) throw new Error('Duplicate physical content identities were found during storage reconciliation.');
    result.set(key, reference);
  }
  return result;
}

function validatePlanRoot(ownerId: string, plan: StorageFileReferencePlan, mappings: readonly StorageRootMapping[]): void {
  if (plan.kind === 'recovery_file') {
    const identity = recoveryReferenceIdentity(plan.relativeKey, plan.projectId);
    if (plan.rootKey !== 'recovery-v1' || !identity || plan.resourceKey !== identity.resourceKey
      || plan.copyKey !== identity.copyKey) {
      throw new Error('A recovery reservation does not use the trusted recovery root.');
    }
    return;
  }
  const mapping = mappings.find((candidate) => candidate.ownerId === ownerId && candidate.rootKey === plan.rootKey);
  if (!mapping || mapping.projectId !== plan.projectId || (plan.kind === 'retained_root') !== (mapping.state === 'retained')) {
    throw new Error('A file reservation has no matching persisted project root.');
  }
  if (plan.resourceKey !== plan.rootKey || plan.copyKey !== plan.relativeKey) {
    throw new Error('A project-file reservation does not match the canonical root identity.');
  }
}

function markOverlappingRootsUnavailable(
  roots: readonly { readonly ownerId: string; readonly absolutePath: string }[],
  unavailable: Set<string>
): void {
  for (let left = 0; left < roots.length; left += 1) {
    const a = roots[left];
    if (!a) continue;
    for (let right = left + 1; right < roots.length; right += 1) {
      const b = roots[right];
      if (!b) continue;
      if (isSameOrNestedPath(a.absolutePath, b.absolutePath)) {
        unavailable.add(a.ownerId);
        unavailable.add(b.ownerId);
      }
    }
  }
}

function isSameOrNestedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
