import type { Project } from '@/modules/projects/domain/project-types';
import type { ActionLedgerRecord, ActionLedgerMutationResult } from '@/modules/action-ledger/domain/action-ledger-types';

export interface ProjectMetadataSearchResult {
  readonly projects: readonly Project[];
  readonly hasMore: boolean;
}

export interface CreatePlanningProjectRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly slug: string;
  readonly objective: string | null;
}

export interface UpdateProjectObjectiveRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly expectedVersion: number;
  readonly objective: string | null;
}

export interface AttachProjectRootRecord {
  readonly ownerId: string;
  readonly projectId: string;
  readonly expectedVersion: number;
  readonly relativeRoot: string;
  readonly relativeRootKey: string;
}

/** Narrow project participants that join the action ledger's transaction. */
export interface IProjectWorkspaceRepository<TTransaction> {
  searchForOwner(ownerId: string, query: string, limit: number): Promise<ProjectMetadataSearchResult>;
  lockOwnerRoots(transaction: TTransaction, ownerId: string): Promise<void>;
  findByIdForOwnerForUpdate(transaction: TTransaction, ownerId: string, projectId: string): Promise<Project | null>;
  listActiveRootKeys(transaction: TTransaction, ownerId: string, exceptProjectId?: string): Promise<readonly string[]>;
  createPlanning(transaction: TTransaction, input: CreatePlanningProjectRecord): Promise<Project>;
  updateObjective(transaction: TTransaction, input: UpdateProjectObjectiveRecord): Promise<Project | null>;
  attachInitialRoot(transaction: TTransaction, input: AttachProjectRootRecord): Promise<Project | null>;
}

/** Undo-only workspace participant. It never creates or removes filesystem content. */
export interface IWorkspaceUndoParticipant<TTransaction> {
  undoWorkspaceInTransaction(
    transaction: TTransaction,
    input: {
      readonly ownerId: string;
      readonly original: ActionLedgerRecord;
      readonly completedTaskCreateActionIds: readonly string[];
    }
  ): Promise<ActionLedgerMutationResult>;
}
