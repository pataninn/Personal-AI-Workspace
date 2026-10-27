import { createHash, randomUUID } from 'node:crypto';

import { ActionLedgerOperationKeyReusedError } from '@/modules/action-ledger/domain/action-ledger-errors';
import type {
  ActionLedgerActorKind,
  ActionLedgerRecord,
  ActionLedgerReversibleFields,
  PersistedActionLedgerRecord
} from '@/modules/action-ledger/domain/action-ledger-types';
import type { IActionLedgerRepository } from '@/modules/action-ledger/repositories/action-ledger-repository';
import {
  ProjectActionKeyReusedError,
  ProjectArchivedError,
  ProjectIdempotencyKeyInvalidError,
  ProjectMetadataQueryInvalidError,
  ProjectNotFoundError,
  ProjectObjectiveInvalidError,
  ProjectRootAlreadyAttachedError,
  ProjectVersionConflictError,
  WorkspaceStorageUnavailableError
} from '@/modules/projects/domain/project-errors';
import { normalizeProjectName } from '@/modules/projects/domain/project-root-policy';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IProjectWorkspaceRepository } from '@/modules/projects/repositories/project-workspace-repository';
import type { IWorkspaceBoundary, ManagedProjectRootAllocation } from '@/modules/projects/repositories/workspace-boundary';

export interface SearchProjectMetadataInput {
  readonly ownerId: string;
  readonly query: unknown;
  readonly limit: number;
}

export interface SearchProjectMetadataResult {
  readonly projects: readonly Project[];
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface ReuseProjectInput {
  readonly ownerId: string;
  readonly projectId: string;
}

export interface CreatePlanningProjectInput {
  readonly ownerId: string;
  readonly operationKey: unknown;
  readonly name: unknown;
  readonly objective?: unknown;
  /** Trusted internal target identity for a sealed accepted Home proposal. */
  readonly projectId?: string;
  readonly actorKind?: ActionLedgerActorKind;
  readonly turnId?: string | null;
  readonly eventContext?: unknown;
}

export interface UpdateProjectObjectiveInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly expectedVersion: number;
  readonly operationKey: unknown;
  readonly objective: unknown;
  /** Trusted Home attribution; HTTP callers leave these unset. */
  readonly actorKind?: ActionLedgerActorKind;
  readonly turnId?: string | null;
  readonly eventContext?: unknown;
}

export interface AttachInitialProjectRootInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly expectedVersion: number;
  readonly operationKey: unknown;
}

export interface ProjectActionResult {
  readonly project: Project;
  readonly receipt: ActionLedgerRecord;
  readonly replayed: boolean;
}

export interface IWorkspacePlanningUseCases {
  search(input: SearchProjectMetadataInput): Promise<SearchProjectMetadataResult>;
  reuse(input: ReuseProjectInput): Promise<Project>;
  createPlanning(input: CreatePlanningProjectInput): Promise<ProjectActionResult>;
  updateObjective(input: UpdateProjectObjectiveInput): Promise<ProjectActionResult>;
  attachInitialRoot(input: AttachInitialProjectRootInput): Promise<ProjectActionResult>;
}

/** Owner-scoped project planning commands and their durable action receipts. */
export class WorkspacePlanningUseCases<TTransaction> implements IWorkspacePlanningUseCases {
  public constructor(
    private readonly projects: IProjectRepository,
    private readonly workspaceProjects: IProjectWorkspaceRepository<TTransaction>,
    private readonly ledger: IActionLedgerRepository<TTransaction>,
    private readonly workspaceBoundary: IWorkspaceBoundary,
    private readonly createId: () => string = randomUUID
  ) {}

  public async search(input: SearchProjectMetadataInput): Promise<SearchProjectMetadataResult> {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (query.length < 2 || query.length > 120 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20) {
      throw new ProjectMetadataQueryInvalidError();
    }
    const result = await this.workspaceProjects.searchForOwner(input.ownerId, query, input.limit);
    return { ...result, limit: input.limit };
  }

  public async reuse(input: ReuseProjectInput): Promise<Project> {
    const project = await this.projects.findByIdForOwner(input.ownerId, input.projectId);
    if (!project) throw new ProjectNotFoundError();
    if (project.status !== 'active') throw new ProjectArchivedError();
    return project;
  }

  public async createPlanning(input: CreatePlanningProjectInput): Promise<ProjectActionResult> {
    const operationKey = this.operationKey(input.operationKey);
    const identity = normalizeProjectName(input.name);
    const objective = normalizeObjective(input.objective);
    const projectId = input.projectId === undefined ? this.createId() : requiredUuid(input.projectId);
    const actorKind = input.actorKind ?? 'manual';
    const persisted = await this.runLedger(() => this.ledger.executeAtomically({
      ownerId: input.ownerId,
      operationKey,
      requestFingerprint: fingerprint({ action: 'workspace.create', name: identity.name, slug: identity.slug, objective }),
      actorKind,
      turnId: input.turnId ?? null,
      targetKind: 'workspace',
      targetId: projectId,
      actionKind: 'workspace.create',
      expectedVersion: null,
      undoOfActionId: null
    }, async (transaction) => {
      await this.workspaceProjects.lockOwnerRoots(transaction, input.ownerId);
      const project = await this.workspaceProjects.createPlanning(transaction, {
        id: projectId,
        ownerId: input.ownerId,
        name: identity.name,
        slug: identity.slug,
        objective
      });
      return {
        preVersion: null,
        postVersion: project.version,
        reversibleFields: {},
        outcome: { targetId: project.id, targetVersion: project.version },
        undoStatus: 'available'
      };
    }, input.eventContext));
    return this.resultForReceipt(input.ownerId, persisted);
  }

  public async updateObjective(input: UpdateProjectObjectiveInput): Promise<ProjectActionResult> {
    const operationKey = this.operationKey(input.operationKey);
    const objective = normalizeObjective(input.objective);
    const actorKind = input.actorKind ?? 'manual';
    const persisted = await this.runLedger(() => this.ledger.executeAtomically({
      ownerId: input.ownerId,
      operationKey,
      requestFingerprint: fingerprint({ action: 'workspace.update.objective', projectId: input.projectId, expectedVersion: input.expectedVersion, objective }),
      actorKind,
      turnId: input.turnId ?? null,
      targetKind: 'workspace',
      targetId: input.projectId,
      actionKind: 'workspace.update',
      expectedVersion: input.expectedVersion,
      undoOfActionId: null
    }, async (transaction) => {
      const current = await this.workspaceProjects.findByIdForOwnerForUpdate(transaction, input.ownerId, input.projectId);
      this.assertActiveAndCurrent(current, input.expectedVersion);
      const updated = await this.workspaceProjects.updateObjective(transaction, {
        ownerId: input.ownerId,
        projectId: input.projectId,
        expectedVersion: input.expectedVersion,
        objective
      });
      if (!updated) throw new ProjectVersionConflictError();
      const reversibleFields: ActionLedgerReversibleFields = {
        objective: { before: current.objective, after: updated.objective }
      };
      return {
        preVersion: current.version,
        postVersion: updated.version,
        reversibleFields,
        outcome: { targetId: updated.id, targetVersion: updated.version },
        undoStatus: 'available'
      };
    }, input.eventContext));
    return this.resultForReceipt(input.ownerId, persisted);
  }

  public async attachInitialRoot(input: AttachInitialProjectRootInput): Promise<ProjectActionResult> {
    const operationKey = this.operationKey(input.operationKey);
    let allocation: ManagedProjectRootAllocation | undefined;
    let persisted: PersistedActionLedgerRecord;
    try {
      persisted = await this.runLedger(() => this.ledger.executeAtomically({
        ownerId: input.ownerId,
        operationKey,
        requestFingerprint: fingerprint({ action: 'workspace.attach-root', projectId: input.projectId, expectedVersion: input.expectedVersion }),
        actorKind: 'manual',
        turnId: null,
        targetKind: 'workspace',
        targetId: input.projectId,
        actionKind: 'workspace.update',
        expectedVersion: input.expectedVersion,
        undoOfActionId: null
      }, async (transaction) => {
        await this.workspaceProjects.lockOwnerRoots(transaction, input.ownerId);
        const current = await this.workspaceProjects.findByIdForOwnerForUpdate(transaction, input.ownerId, input.projectId);
        this.assertActiveAndCurrent(current, input.expectedVersion);
        if (current.relativeRoot !== null) throw new ProjectRootAlreadyAttachedError();

        if (!this.workspaceBoundary.allocateManagedProjectRoot) throw new WorkspaceStorageUnavailableError();
        allocation = await this.workspaceBoundary.allocateManagedProjectRoot(input.ownerId, input.projectId);
        const relativeRoot = allocation.relativeRoot;
        const updated = await this.workspaceProjects.attachInitialRoot(transaction, {
          ownerId: input.ownerId,
          projectId: input.projectId,
          expectedVersion: input.expectedVersion,
          relativeRoot,
          relativeRootKey: relativeRoot,
          storageKind: 'managed'
        });
        if (!updated) throw new ProjectVersionConflictError();
        return {
          preVersion: current.version,
          postVersion: updated.version,
          reversibleFields: {},
          outcome: { targetId: updated.id, targetVersion: updated.version },
          undoStatus: 'not_reversible'
        };
      }));
    } catch (error: unknown) {
      if (allocation) {
        const allocated = allocation;
        // A commit response can be lost: the recovery port waits on the same
        // owner/row locks before checking the association on the primary database.
        try {
          if (!this.workspaceProjects.recoverUnattachedRoot) throw new WorkspaceStorageUnavailableError();
          await this.workspaceProjects.recoverUnattachedRoot(input.ownerId, input.projectId, () => allocated.discardIfEmpty());
        } catch {
          throw new WorkspaceStorageUnavailableError();
        }
      }
      throw error;
    }
    return this.resultForReceipt(input.ownerId, persisted);
  }

  private operationKey(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
      throw new ProjectIdempotencyKeyInvalidError();
    }
    return value;
  }

  private assertActiveAndCurrent(project: Project | null, expectedVersion: number): asserts project is Project {
    if (!project) throw new ProjectNotFoundError();
    if (project.status !== 'active') throw new ProjectArchivedError();
    if (project.version !== expectedVersion) throw new ProjectVersionConflictError();
  }

  private async resultForReceipt(ownerId: string, persisted: PersistedActionLedgerRecord): Promise<ProjectActionResult> {
    const project = await this.projects.findByIdForOwner(ownerId, persisted.record.targetId);
    if (!project) throw new ProjectNotFoundError();
    return { project, receipt: persisted.record, replayed: persisted.replayed };
  }

  private async runLedger<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error: unknown) {
      if (error instanceof ActionLedgerOperationKeyReusedError) throw new ProjectActionKeyReusedError();
      throw error;
    }
  }
}

function normalizeObjective(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ProjectObjectiveInvalidError();
  const objective = value.trim();
  if (objective.length > 2000) throw new ProjectObjectiveInvalidError();
  return objective || null;
}

function fingerprint(value: object): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/** Canonical workspace receipt fingerprint shared with Home's sealed proposal recorder. */
export function workspacePlanningFingerprint(
  action: 'workspace.create' | 'workspace.update',
  input: CreatePlanningProjectInput | UpdateProjectObjectiveInput
): string {
  if (action === 'workspace.create') {
    const create = input as CreatePlanningProjectInput;
    const identity = normalizeProjectName(create.name);
    const objective = normalizeObjective(create.objective);
    return fingerprint({ action, name: identity.name, slug: identity.slug, objective });
  }
  const update = input as UpdateProjectObjectiveInput;
  const objective = normalizeObjective(update.objective);
  return fingerprint({ action: 'workspace.update.objective', projectId: update.projectId, expectedVersion: update.expectedVersion, objective });
}

function requiredUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new ProjectIdempotencyKeyInvalidError();
  }
  return value;
}
