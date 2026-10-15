import type { ActionLedgerActorKind, ActionLedgerMutationResult } from '@/modules/action-ledger/domain/action-ledger-types';
import type { ProjectTask, ProjectTaskImportance, ProjectTaskSubtask, ProjectTaskStatus } from '@/modules/tasks/domain/project-task';

export interface CreateTaskMutationInput {
  readonly ownerId: string;
  readonly taskId: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly details: string | null;
  readonly importance: ProjectTaskImportance;
  readonly deadline: string | null;
  readonly subtasks: ProjectTask['subtasks'];
  readonly actorKind: ActionLedgerActorKind;
  readonly expectedOrderVersion?: number;
}

export interface UpdateTaskMutationInput {
  readonly ownerId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  /** Restricts compatibility adapters to the project named by their route. */
  readonly expectedProjectId?: string;
  readonly title?: string;
  readonly details?: string | null;
  readonly importance?: ProjectTaskImportance;
  readonly deadline?: string | null;
  readonly subtasks?: ProjectTask['subtasks'];
  readonly status?: Exclude<ProjectTaskStatus, 'archived'>;
  readonly actorKind: ActionLedgerActorKind;
}

export interface MoveTaskMutationInput {
  readonly ownerId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly destinationProjectId: string | null;
  readonly expectedSourceOrderVersion?: number;
  readonly expectedDestinationOrderVersion?: number;
  readonly actorKind: ActionLedgerActorKind;
}

export interface ArchiveTaskMutationInput {
  readonly ownerId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  /** Restricts compatibility adapters to the project named by their route. */
  readonly expectedProjectId?: string;
  readonly expectedOrderVersion?: number;
  readonly actorKind: ActionLedgerActorKind;
}

export interface AppliedTaskMutation extends ActionLedgerMutationResult {
  readonly task: ProjectTask;
}

/** Narrow transaction participant. The action ledger owns and supplies the transaction. */
export interface ITaskMutationParticipant<TTransaction> {
  createInTransaction(transaction: TTransaction, input: CreateTaskMutationInput): Promise<AppliedTaskMutation>;
  updateInTransaction(transaction: TTransaction, input: UpdateTaskMutationInput): Promise<AppliedTaskMutation>;
  moveInTransaction(transaction: TTransaction, input: MoveTaskMutationInput): Promise<AppliedTaskMutation>;
  archiveInTransaction(transaction: TTransaction, input: ArchiveTaskMutationInput): Promise<AppliedTaskMutation>;
}
