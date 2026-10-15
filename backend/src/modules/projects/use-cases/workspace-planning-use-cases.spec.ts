import { ActionLedgerOperationKeyReusedError } from '@/modules/action-ledger/domain/action-ledger-errors';
import type {
  ActionLedgerExecutionInput,
  ActionLedgerMutationResult,
  ActionLedgerRecord,
  PersistedActionLedgerRecord
} from '@/modules/action-ledger/domain/action-ledger-types';
import type { IActionLedgerRepository } from '@/modules/action-ledger/repositories/action-ledger-repository';
import {
  ProjectActionKeyReusedError,
  ProjectArchivedError,
  ProjectNotFoundError,
  ProjectRootAlreadyAttachedError,
  ProjectRootOverlapError,
  ProjectVersionConflictError
} from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type {
  AttachProjectRootRecord,
  CreatePlanningProjectRecord,
  IProjectWorkspaceRepository,
  ProjectMetadataSearchResult,
  UpdateProjectObjectiveRecord
} from '@/modules/projects/repositories/project-workspace-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import { WorkspacePlanningUseCases } from '@/modules/projects/use-cases/workspace-planning-use-cases';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const NEW_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const RECEIPT_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-16T00:00:00.000Z');

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    name: 'Launch planning',
    slug: 'launch-planning',
    relativeRoot: null,
    objective: 'Ship the launch',
    status: 'active',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

class MemoryProjectRepository implements IProjectRepository, IProjectWorkspaceRepository<void> {
  public readonly records = new Map<string, Project>([[PROJECT_ID, project()]]);
  public readonly sequence: string[] = [];
  public readonly searchForOwner = jest.fn(async (ownerId: string, query: string, limit: number): Promise<ProjectMetadataSearchResult> => ({
    projects: [...this.records.values()].filter((item) => item.ownerId === ownerId && item.status === 'active' && item.name.toLowerCase().includes(query.toLowerCase())).slice(0, limit),
    hasMore: false
  }));

  public async listByOwner(ownerId: string, includeArchived: boolean): Promise<readonly Project[]> {
    return [...this.records.values()].filter((item) => item.ownerId === ownerId && (includeArchived || item.status === 'active'));
  }

  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> {
    const item = this.records.get(projectId);
    return item?.ownerId === ownerId ? item : null;
  }

  public async listActiveRoots(ownerId: string): Promise<readonly string[]> {
    return [...this.records.values()].filter((item) => item.ownerId === ownerId && item.status === 'active' && item.relativeRoot !== null).map((item) => item.relativeRoot as string);
  }

  public async create(input: Parameters<IProjectRepository['create']>[0]): Promise<Project> {
    const created = project({ ...input, id: NEW_PROJECT_ID, version: 1 });
    this.records.set(created.id, created);
    return created;
  }

  public async updateStatus(input: Parameters<IProjectRepository['updateStatus']>[0]): Promise<Project | null> {
    const current = await this.findByIdForOwner(input.ownerId, input.projectId);
    if (!current || current.version !== input.expectedVersion) return null;
    const updated = { ...current, status: input.status, version: current.version + 1 };
    this.records.set(updated.id, updated);
    return updated;
  }

  public async lockOwnerRoots(): Promise<void> { this.sequence.push('owner-lock'); }

  public async findByIdForOwnerForUpdate(_transaction: void, ownerId: string, projectId: string): Promise<Project | null> {
    this.sequence.push('row-lock');
    return this.findByIdForOwner(ownerId, projectId);
  }

  public async listActiveRootKeys(_transaction: void, ownerId: string, exceptProjectId?: string): Promise<readonly string[]> {
    return [...this.records.values()]
      .filter((item) => item.ownerId === ownerId && item.status === 'active' && item.id !== exceptProjectId && item.relativeRoot !== null)
      .map((item) => item.relativeRoot as string);
  }

  public async createPlanning(_transaction: void, input: CreatePlanningProjectRecord): Promise<Project> {
    const created = project({ ...input, relativeRoot: null, version: 1 });
    this.records.set(created.id, created);
    return created;
  }

  public async updateObjective(_transaction: void, input: UpdateProjectObjectiveRecord): Promise<Project | null> {
    const current = await this.findByIdForOwner(input.ownerId, input.projectId);
    if (!current || current.version !== input.expectedVersion) return null;
    const updated = { ...current, objective: input.objective, version: current.version + 1 };
    this.records.set(updated.id, updated);
    return updated;
  }

  public async attachInitialRoot(_transaction: void, input: AttachProjectRootRecord): Promise<Project | null> {
    const current = await this.findByIdForOwner(input.ownerId, input.projectId);
    if (!current || current.version !== input.expectedVersion || current.relativeRoot !== null) return null;
    const updated = { ...current, relativeRoot: input.relativeRoot, version: current.version + 1 };
    this.records.set(updated.id, updated);
    return updated;
  }
}

class MemoryActionLedger implements IActionLedgerRepository<void> {
  public readonly records = new Map<string, ActionLedgerRecord>();
  public callbackCount = 0;

  public async executeAtomically(input: ActionLedgerExecutionInput, mutate: (transaction: void) => Promise<ActionLedgerMutationResult>): Promise<PersistedActionLedgerRecord> {
    const identity = `${input.ownerId}:${input.operationKey}`;
    const existing = this.records.get(identity);
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) throw new ActionLedgerOperationKeyReusedError();
      return { record: existing, replayed: true };
    }
    this.callbackCount += 1;
    const result = await mutate(undefined);
    const record: ActionLedgerRecord = {
      ...input,
      id: RECEIPT_ID,
      preVersion: result.preVersion,
      postVersion: result.postVersion,
      reversibleFields: result.reversibleFields,
      outcome: result.outcome,
      undoStatus: result.undoStatus,
      undoActionId: null,
      createdAt: NOW.toISOString()
    };
    this.records.set(identity, record);
    return { record, replayed: false };
  }

  public async findForOwner(ownerId: string, operationKey: string): Promise<ActionLedgerRecord | null> {
    return this.records.get(`${ownerId}:${operationKey}`) ?? null;
  }
}

function fixture(projects = new MemoryProjectRepository()) {
  const ledger = new MemoryActionLedger();
  const boundary: IWorkspaceBoundary & { readonly validateProjectRoot: jest.Mock; readonly createProjectRoot: jest.Mock } = {
    getSnapshot: jest.fn().mockResolvedValue({ status: 'ready' }),
    assertReady: jest.fn().mockResolvedValue(undefined),
    validateProjectRoot: jest.fn(async (root: string) => root),
    createProjectRoot: jest.fn(async (root: string) => root)
  };
  const useCases = new WorkspacePlanningUseCases(projects, projects, ledger, boundary, () => NEW_PROJECT_ID);
  return { boundary, ledger, projects, useCases };
}

describe('WorkspacePlanningUseCases', () => {
  it('bounds metadata search and passes the authenticated owner to the repository', async () => {
    const { projects, useCases } = fixture();
    await expect(useCases.search({ ownerId: OWNER_ID, query: '  launch ', limit: 8 })).resolves.toMatchObject({ limit: 8, projects: [{ id: PROJECT_ID }], hasMore: false });
    expect(projects.searchForOwner).toHaveBeenCalledWith(OWNER_ID, 'launch', 8);
    await expect(useCases.search({ ownerId: OWNER_ID, query: 'x', limit: 8 })).rejects.toThrow();
  });

  it('requires explicit owner-owned active reuse and never selects a project by search text', async () => {
    const { useCases } = fixture();
    await expect(useCases.reuse({ ownerId: OTHER_OWNER_ID, projectId: PROJECT_ID })).rejects.toBeInstanceOf(ProjectNotFoundError);
    const archived = fixture(new MemoryProjectRepository());
    archived.projects.records.set(PROJECT_ID, project({ status: 'archived' }));
    await expect(archived.useCases.reuse({ ownerId: OWNER_ID, projectId: PROJECT_ID })).rejects.toBeInstanceOf(ProjectArchivedError);
    await expect(useCases.reuse({ ownerId: OWNER_ID, projectId: PROJECT_ID })).resolves.toMatchObject({ id: PROJECT_ID });
  });

  it('creates a planning workspace once and replays its owner-scoped receipt without invoking the mutation again', async () => {
    const { ledger, projects, useCases } = fixture();
    const input = { ownerId: OWNER_ID, operationKey: 'planning-1', name: ' New idea ', objective: ' Plan it ' };
    const first = await useCases.createPlanning(input);
    const replay = await useCases.createPlanning(input);

    expect(first).toMatchObject({ replayed: false, project: { id: NEW_PROJECT_ID, name: 'New idea', objective: 'Plan it' }, receipt: { actionKind: 'workspace.create', turnId: null, undoStatus: 'available' } });
    expect(replay).toMatchObject({ replayed: true, receipt: { id: first.receipt.id, targetId: NEW_PROJECT_ID } });
    expect(ledger.callbackCount).toBe(1);
    expect(projects.records.size).toBe(2);
    await expect(useCases.createPlanning({ ...input, name: 'Different idea' })).rejects.toBeInstanceOf(ProjectActionKeyReusedError);
  });

  it('guards objective edits by owner and version and replays without applying the update twice', async () => {
    const { ledger, useCases } = fixture();
    const input = { ownerId: OWNER_ID, projectId: PROJECT_ID, expectedVersion: 1, operationKey: 'objective-1', objective: ' Revised objective ' };
    const first = await useCases.updateObjective(input);
    const replay = await useCases.updateObjective(input);

    expect(first).toMatchObject({ project: { objective: 'Revised objective', version: 2 }, receipt: { preVersion: 1, postVersion: 2, undoStatus: 'available' } });
    expect(replay.replayed).toBe(true);
    expect(ledger.callbackCount).toBe(1);
    await expect(useCases.updateObjective({ ...input, operationKey: 'objective-stale' })).rejects.toBeInstanceOf(ProjectVersionConflictError);
    await expect(useCases.updateObjective({ ...input, ownerId: OTHER_OWNER_ID, operationKey: 'foreign' })).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('attaches an existing root read-only, preserves dot, checks normalized overlaps under the owner lock, and records a non-reversible receipt', async () => {
    const { boundary, ledger, projects, useCases } = fixture();
    const input = { ownerId: OWNER_ID, projectId: PROJECT_ID, expectedVersion: 1, operationKey: 'attach-dot', relativeRoot: '.' };
    const result = await useCases.attachInitialRoot(input);
    const replay = await useCases.attachInitialRoot(input);

    expect(result).toMatchObject({ project: { relativeRoot: '.', version: 2 }, receipt: { undoStatus: 'not_reversible', reversibleFields: {} } });
    expect(replay).toMatchObject({ replayed: true, project: { relativeRoot: '.', version: 2 }, receipt: { id: result.receipt.id } });
    expect(ledger.callbackCount).toBe(1);
    expect(boundary.validateProjectRoot).toHaveBeenCalledTimes(1);
    expect(projects.sequence.slice(0, 2)).toEqual(['owner-lock', 'row-lock']);
    expect(boundary.validateProjectRoot).toHaveBeenCalledWith('.');
    expect(boundary.createProjectRoot).not.toHaveBeenCalled();

    const overlap = fixture();
    overlap.projects.records.set('55555555-5555-4555-8555-555555555555', project({ id: '55555555-5555-4555-8555-555555555555', name: 'Existing folder', relativeRoot: 'apps/site' }));
    await expect(overlap.useCases.attachInitialRoot({ ownerId: OWNER_ID, projectId: PROJECT_ID, expectedVersion: 1, operationKey: 'attach-overlap', relativeRoot: '.' }))
      .rejects.toBeInstanceOf(ProjectRootOverlapError);
    expect(overlap.projects.records.get(PROJECT_ID)?.relativeRoot).toBeNull();
    expect(overlap.ledger.records.size).toBe(0);
  });

  it('rejects archived, foreign, and already-attached targets before filesystem validation; validation failure commits no receipt', async () => {
    const archived = fixture();
    archived.projects.records.set(PROJECT_ID, project({ status: 'archived' }));
    await expect(archived.useCases.attachInitialRoot({ ownerId: OWNER_ID, projectId: PROJECT_ID, expectedVersion: 1, operationKey: 'archived', relativeRoot: 'apps/site' }))
      .rejects.toBeInstanceOf(ProjectArchivedError);
    expect(archived.boundary.validateProjectRoot).not.toHaveBeenCalled();

    const foreign = fixture();
    await expect(foreign.useCases.attachInitialRoot({ ownerId: OTHER_OWNER_ID, projectId: PROJECT_ID, expectedVersion: 1, operationKey: 'foreign', relativeRoot: 'apps/site' }))
      .rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(foreign.boundary.validateProjectRoot).not.toHaveBeenCalled();

    const attached = fixture();
    attached.projects.records.set(PROJECT_ID, project({ relativeRoot: 'apps/site' }));
    await expect(attached.useCases.attachInitialRoot({ ownerId: OWNER_ID, projectId: PROJECT_ID, expectedVersion: 1, operationKey: 'attached', relativeRoot: 'apps/site' }))
      .rejects.toBeInstanceOf(ProjectRootAlreadyAttachedError);
    expect(attached.boundary.validateProjectRoot).not.toHaveBeenCalled();

    const unavailable = fixture();
    const validationFailure = new Error('existing root could not be verified');
    unavailable.boundary.validateProjectRoot.mockRejectedValue(validationFailure);
    await expect(unavailable.useCases.attachInitialRoot({ ownerId: OWNER_ID, projectId: PROJECT_ID, expectedVersion: 1, operationKey: 'validation-failure', relativeRoot: 'apps/site' }))
      .rejects.toBe(validationFailure);
    expect(unavailable.projects.records.get(PROJECT_ID)?.relativeRoot).toBeNull();
    expect(unavailable.ledger.records.size).toBe(0);

    const failedUpdate = fixture();
    const persistenceFailure = new Error('root association update failed');
    jest.spyOn(failedUpdate.projects, 'attachInitialRoot').mockRejectedValue(persistenceFailure);
    await expect(failedUpdate.useCases.attachInitialRoot({ ownerId: OWNER_ID, projectId: PROJECT_ID, expectedVersion: 1, operationKey: 'update-failure', relativeRoot: 'apps/site' }))
      .rejects.toBe(persistenceFailure);
    expect(failedUpdate.boundary.validateProjectRoot).toHaveBeenCalledWith('apps/site');
    expect(failedUpdate.boundary.createProjectRoot).not.toHaveBeenCalled();
    expect(failedUpdate.projects.records.get(PROJECT_ID)?.relativeRoot).toBeNull();
    expect(failedUpdate.ledger.records.size).toBe(0);
  });
});
