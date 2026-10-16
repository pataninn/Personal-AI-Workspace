import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { HomeConversationInputInvalidError, HomeConversationNotFoundError, HomeTurnNotActiveError, HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { HomePlanningScopeConflictError } from '@/modules/home-assistant/domain/home-planning-errors';
import type { HomeConversationScope } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomePlanningToolRequest, HomePlanningToolResultCandidate, HomePlanningToolResolution, IHomePlanningToolRequestHandler } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';
import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';
import type { GlobalTaskQueryItem } from '@/modules/tasks/domain/global-task-query';
import type { GlobalTaskQueryFilters } from '@/modules/tasks/domain/global-task-query';
import type { GetGlobalTaskUseCase, ListGlobalTasksUseCase } from '@/modules/tasks/use-cases/global-task-query-use-cases';
import type { ITaskMutationCommands } from '@/modules/tasks/use-cases/task-mutation-use-cases';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IWorkspacePlanningUseCases } from '@/modules/projects/use-cases/workspace-planning-use-cases';
import type { IActionUndoUseCases } from '@/modules/home-assistant/use-cases/action-undo-use-cases';
import { parseHomePlanningToolArgs, resolveDeadline, stableJson, type HomePlanningToolName } from '@/modules/home-assistant/use-cases/home-planning-command-validation';

const MAX_TASK_LIST_BYTES = 64 * 1024;
const MAX_TASK_DETAIL_BYTES = 16 * 1024;
const MAX_WORKSPACE_BYTES = 64 * 1024;

export interface HomeProposalDraftCreator {
  createFromTool(input: HomePlanningToolRequest, args: { readonly items: readonly unknown[] }): Promise<{ readonly id: string; readonly revision: number; readonly itemCount: number }>;
}

export interface HomePlanningToolRequestHandlerDependencies {
  readonly conversations: IHomeConversationRepository;
  readonly listTasks: ListGlobalTasksUseCase;
  readonly getTask: GetGlobalTaskUseCase;
  readonly taskMutations: ITaskMutationCommands;
  readonly workspaces: IWorkspacePlanningUseCases;
  readonly undo: IActionUndoUseCases;
  readonly proposals: HomeProposalDraftCreator;
  readonly timeZone?: string;
}

/** Resolves only the fixed Home planning tools against the persisted owner, turn, and scope. */
export class HomePlanningToolRequestHandler implements IHomePlanningToolRequestHandler {
  public constructor(private readonly dependencies: HomePlanningToolRequestHandlerDependencies) {}

  public async resolve(input: HomePlanningToolRequest): Promise<HomePlanningToolResolution | null> {
    const args = parseHomePlanningToolArgs(input);
    const { conversation, turn } = await this.assertActiveSource(input);
    if (conversation.scope.kind !== input.scope.kind
      || (conversation.scope.kind === 'workspace' && input.scope.kind === 'workspace' && conversation.scope.workspaceId !== input.scope.workspaceId)) {
      throw new HomeConversationNotFoundError();
    }

    const operationKey = directOperationKey(input);
    switch (input.name as HomePlanningToolName) {
      case 'home_list_tasks':
        return this.readResolution(input.scope, await this.listTasks(input.ownerId, input.scope, args));
      case 'home_get_task':
        return this.readResolution(input.scope, await this.getTaskResult(input.ownerId, input.scope, args));
      case 'home_search_workspaces':
        return this.readResolution(input.scope, await this.searchWorkspaces(input.ownerId, input.scope, args));
      case 'home_reuse_workspace':
        return this.readResolution(input.scope, await this.reuseWorkspace(input.ownerId, input.scope, args));
      case 'home_create_task': {
        const workspaceId = (args.workspaceId as string | null | undefined) ?? null;
        await this.assertTaskWorkspace(input.ownerId, input.scope, workspaceId);
        const receipt = await this.dependencies.taskMutations.create({
          ownerId: input.ownerId,
          projectId: workspaceId,
          operationKey,
          actorKind: 'assistant',
          turnId: turn.id,
          title: args.title,
          ...(args.details === undefined ? {} : { details: args.details }),
          ...(args.importance === undefined ? {} : { importance: args.importance }),
          deadline: resolveDeadline(args.deadline ?? null, this.dependencies.timeZone),
          subtasks: args.subtasks ?? []
        });
        return immediate(receipt.receipt, receipt.replayed);
      }
      case 'home_update_task': {
        const taskId = args.taskId as string;
        const current = await this.scopedTask(input.ownerId, input.scope, taskId, false);
        const subtasks = args.subtasks === undefined ? undefined : normalizeSubtaskPatch(args.subtasks, current.task.subtasks.map((item) => item.id));
        const receipt = await this.dependencies.taskMutations.update({
          ownerId: input.ownerId, taskId, expectedVersion: args.expectedVersion as number,
          ...(current.task.projectId ? { expectedProjectId: current.task.projectId } : {}),
          operationKey, actorKind: 'assistant', turnId: turn.id,
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.details === undefined ? {} : { details: args.details }),
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.importance === undefined ? {} : { importance: args.importance }),
          ...(args.deadline === undefined ? {} : { deadline: resolveDeadline(args.deadline, this.dependencies.timeZone) }),
          ...(subtasks === undefined ? {} : { subtasks })
        });
        return immediate(receipt.receipt, receipt.replayed);
      }
      case 'home_move_task': {
        const taskId = args.taskId as string;
        const current = await this.scopedTask(input.ownerId, input.scope, taskId, false);
        const destination = args.workspaceId as string | null;
        await this.assertTaskWorkspace(input.ownerId, input.scope, destination);
        const receipt = await this.dependencies.taskMutations.move({
          ownerId: input.ownerId, taskId, expectedVersion: args.expectedVersion as number, workspaceId: destination,
          operationKey, actorKind: 'assistant', turnId: turn.id,
          ...(args.expectedSourceOrderVersion === undefined ? {} : { expectedSourceOrderVersion: args.expectedSourceOrderVersion as number }),
          ...(args.expectedDestinationOrderVersion === undefined ? {} : { expectedDestinationOrderVersion: args.expectedDestinationOrderVersion as number })
        });
        return immediate(receipt.receipt, receipt.replayed);
      }
      case 'home_archive_task': {
        const taskId = args.taskId as string;
        // An archived task is still needed to re-enter the canonical ledger for an identical retry.
        const current = await this.scopedTask(input.ownerId, input.scope, taskId, true);
        const receipt = await this.dependencies.taskMutations.archive({
          ownerId: input.ownerId, taskId, expectedVersion: args.expectedVersion as number,
          ...(current.task.projectId ? { expectedProjectId: current.task.projectId } : {}),
          ...(args.expectedOrderVersion === undefined ? {} : { expectedOrderVersion: args.expectedOrderVersion as number }),
          operationKey, actorKind: 'assistant', turnId: turn.id
        });
        return immediate(receipt.receipt, receipt.replayed);
      }
      case 'home_create_workspace': {
        if (input.scope.kind !== 'home') throw new HomePlanningScopeConflictError();
        const result = await this.dependencies.workspaces.createPlanning({
          ownerId: input.ownerId, operationKey, name: args.name,
          ...(args.objective === undefined ? {} : { objective: args.objective }), actorKind: 'assistant', turnId: turn.id
        });
        return immediate(result.receipt, result.replayed);
      }
      case 'home_update_workspace_objective': {
        const workspaceId = args.workspaceId as string;
        await this.assertWorkspace(input.ownerId, input.scope, workspaceId);
        const result = await this.dependencies.workspaces.updateObjective({
          ownerId: input.ownerId, projectId: workspaceId, expectedVersion: args.expectedVersion as number,
          operationKey, objective: args.objective, actorKind: 'assistant', turnId: turn.id
        });
        return immediate(result.receipt, result.replayed);
      }
      case 'home_undo_action': {
        const actionId = args.actionId as string;
        const original = await this.dependencies.undo.getReceipt({ ownerId: input.ownerId, actionId });
        if (input.scope.kind === 'workspace') await this.assertUndoScope(input.ownerId, input.scope, original);
        const result = await this.dependencies.undo.undo({
          ownerId: input.ownerId, actionId, operationKey, actorKind: 'assistant', turnId: turn.id
        });
        return immediate(result.undoReceipt, result.replayed);
      }
      case 'home_propose_bulk_changes': {
        const result = await this.dependencies.proposals.createFromTool(input, args as unknown as { readonly items: readonly unknown[] });
        return { kind: 'immediate', result: { outcome: 'shared', data: { proposal: { id: result.id, state: 'review_required', revision: result.revision, itemCount: result.itemCount }, execution: { state: 'proposal_saved' } } } };
      }
      default:
        return null;
    }
  }

  private async assertActiveSource(input: HomePlanningToolRequest) {
    const conversation = await this.dependencies.conversations.findForOwner(input.ownerId, input.conversationId);
    if (!conversation) throw new HomeConversationNotFoundError();
    const turn = await this.dependencies.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId);
    if (!turn) throw new HomeTurnNotFoundError();
    if (turn.status !== 'running') throw new HomeTurnNotActiveError();
    if (conversation.scope.kind === 'workspace') await this.assertWorkspace(input.ownerId, conversation.scope, conversation.scope.workspaceId);
    return { conversation, turn };
  }

  private async assertWorkspace(ownerId: string, scope: HomeConversationScope, workspaceId: string): Promise<Project> {
    const project = await this.dependencies.workspaces.reuse({ ownerId, projectId: workspaceId });
    if (project.status !== 'active' || (scope.kind === 'workspace' && (scope.workspaceId !== workspaceId || project.relativeRoot !== null))) {
      throw new HomePlanningScopeConflictError();
    }
    return project;
  }

  private async assertTaskWorkspace(ownerId: string, scope: HomeConversationScope, workspaceId: string | null): Promise<void> {
    if (scope.kind === 'workspace') {
      if (workspaceId !== scope.workspaceId) throw new HomePlanningScopeConflictError();
      await this.assertWorkspace(ownerId, scope, workspaceId);
    } else if (workspaceId !== null) {
      await this.assertWorkspace(ownerId, scope, workspaceId);
    }
  }

  private async scopedTask(ownerId: string, scope: HomeConversationScope, taskId: string, includeArchived: boolean): Promise<GlobalTaskQueryItem> {
    const item = await this.dependencies.getTask.execute({ ownerId, taskId, includeArchived });
    if (scope.kind === 'workspace') {
      await this.assertWorkspace(ownerId, scope, scope.workspaceId);
      if (item.task.projectId !== scope.workspaceId || item.workspace?.status !== 'active') throw new HomePlanningScopeConflictError();
    } else if (item.workspace?.status === 'archived' && !includeArchived) {
      throw new HomePlanningScopeConflictError();
    }
    return item;
  }

  private async listTasks(ownerId: string, scope: HomeConversationScope, args: Record<string, unknown>): Promise<HomePlanningToolResultCandidate> {
    const filters: GlobalTaskQueryFilters = {
      inboxOnly: args.inboxOnly === true,
      includeArchived: args.includeArchived === true,
      limit: (args.limit as number | undefined) ?? 10,
      ...(args.workspaceId ? { workspaceId: args.workspaceId as string } : {}),
      ...(args.status ? { status: args.status as NonNullable<GlobalTaskQueryFilters['status']> } : {}),
      ...(args.importance ? { importance: args.importance as NonNullable<GlobalTaskQueryFilters['importance']> } : {}),
      ...(args.deadlineFrom ? { deadlineFrom: args.deadlineFrom as string } : {}),
      ...(args.deadlineTo ? { deadlineTo: args.deadlineTo as string } : {}),
      ...(args.q ? { q: args.q as string } : {})
    };
    if (scope.kind === 'workspace') {
      await this.assertWorkspace(ownerId, scope, scope.workspaceId);
      if ((filters.workspaceId && filters.workspaceId !== scope.workspaceId) || filters.inboxOnly) throw new HomePlanningScopeConflictError();
      Object.assign(filters, { workspaceId: scope.workspaceId, inboxOnly: false });
    } else if (filters.workspaceId && !filters.includeArchived) {
      await this.assertWorkspace(ownerId, scope, filters.workspaceId);
    }
    const page = await this.dependencies.listTasks.execute({ ownerId, filters, ...(args.cursor ? { cursor: args.cursor as string } : {}) });
    const items = page.items.filter((item) => item.workspace?.status !== 'archived' || filters.includeArchived).map((item) => taskSummary(item));
    return boundedCandidate(scope, ['task_metadata'], items.length, { items, nextCursor: page.nextCursor }, MAX_TASK_LIST_BYTES);
  }

  private async getTaskResult(ownerId: string, scope: HomeConversationScope, args: Record<string, unknown>): Promise<HomePlanningToolResultCandidate> {
    const includeArchived = args.includeArchived === true;
    const item = await this.scopedTask(ownerId, scope, args.taskId as string, includeArchived);
    return boundedCandidate(scope, ['task_metadata'], 1, { task: taskDetail(item) }, MAX_TASK_DETAIL_BYTES);
  }

  private async searchWorkspaces(ownerId: string, scope: HomeConversationScope, args: Record<string, unknown>): Promise<HomePlanningToolResultCandidate> {
    const limit = (args.limit as number | undefined) ?? 10;
    const query = args.query as string;
    const result = scope.kind === 'home'
      ? await this.dependencies.workspaces.search({ ownerId, query, limit })
      : { projects: [await this.assertWorkspace(ownerId, scope, scope.workspaceId)].filter((project) => `${project.name} ${project.objective ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, limit), limit, hasMore: false };
    const items = result.projects.filter((project) => project.status === 'active').map(workspaceMetadata);
    return boundedCandidate(scope, ['workspace_metadata'], items.length, { items }, MAX_WORKSPACE_BYTES);
  }

  private async reuseWorkspace(ownerId: string, scope: HomeConversationScope, args: Record<string, unknown>): Promise<HomePlanningToolResultCandidate> {
    const project = await this.assertWorkspace(ownerId, scope, args.workspaceId as string);
    return boundedCandidate(scope, ['workspace_metadata'], 1, { workspace: workspaceMetadata(project) }, 16 * 1024);
  }

  private async assertUndoScope(ownerId: string, scope: HomeConversationScope, original: ActionLedgerRecord): Promise<void> {
    if (scope.kind !== 'workspace') throw new HomePlanningScopeConflictError();
    await this.assertWorkspace(ownerId, scope, scope.workspaceId);
    if (original.targetKind === 'workspace') {
      if (original.targetId !== scope.workspaceId) throw new HomePlanningScopeConflictError();
      return;
    }
    const current = await this.dependencies.getTask.execute({ ownerId, taskId: original.targetId, includeArchived: true });
    if (current.task.projectId !== scope.workspaceId) throw new HomePlanningScopeConflictError();
  }

  private readResolution(scope: HomeConversationScope, candidate: HomePlanningToolResultCandidate): HomePlanningToolResolution {
    if (candidate.scope.kind !== scope.kind || (scope.kind === 'workspace' && candidate.scope.kind === 'workspace' && candidate.scope.workspaceId !== scope.workspaceId)) {
      throw new HomePlanningScopeConflictError();
    }
    if (candidate.itemCount === 0) return { kind: 'immediate', result: { outcome: 'shared', data: candidate.data } };
    return { kind: 'consented', candidate };
  }
}

function normalizeSubtaskPatch(value: unknown, existingIds: readonly string[]): readonly unknown[] {
  if (!Array.isArray(value)) throw new HomeConversationInputInvalidError('The task checklist is invalid.');
  const known = new Set(existingIds);
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const row = item as Record<string, unknown>;
    if (row.id !== undefined && !known.has(row.id as string)) throw new HomeConversationInputInvalidError('A checklist item does not belong to this task.');
    return { ...row, ...(row.id === undefined ? { completed: row.completed ?? false } : {}) };
  });
}

function taskSummary(item: GlobalTaskQueryItem) {
  return {
    id: item.task.id,
    title: item.task.title,
    status: item.task.status,
    importance: item.task.importance,
    deadline: item.task.deadline,
    workspaceId: item.task.projectId,
    workspaceName: item.workspace?.name ?? null,
    version: item.task.version,
    subtaskCount: item.task.subtasks.length,
    completedSubtaskCount: item.task.subtasks.filter((subtask) => subtask.completed).length
  };
}

function taskDetail(item: GlobalTaskQueryItem) {
  return {
    id: item.task.id,
    title: item.task.title,
    details: item.task.details,
    status: item.task.status,
    importance: item.task.importance,
    deadline: item.task.deadline,
    workspaceId: item.task.projectId,
    workspaceName: item.workspace?.name ?? null,
    version: item.task.version,
    subtasks: item.task.subtasks.map(({ id, title, completed }) => ({ id, title, completed }))
  };
}

function workspaceMetadata(project: Project) {
  return { id: project.id, name: project.name, objective: project.objective, version: project.version };
}

function boundedCandidate(scope: HomeConversationScope, categories: HomePlanningToolResultCandidate['categories'], itemCount: number, data: Readonly<Record<string, unknown>>, maxBytes: number): HomePlanningToolResultCandidate {
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
  if (bytes < 1 || bytes > maxBytes) throw new HomeConversationInputInvalidError('The Home planning result exceeds its supported size.');
  return { scope, categories, itemCount, data };
}

function immediate(record: ActionLedgerRecord, replayed: boolean): HomePlanningToolResolution {
  return { kind: 'immediate', result: { outcome: 'shared', data: { receipt: { id: record.id, actionKind: record.actionKind, targetKind: record.targetKind, targetId: record.targetId, targetVersion: record.outcome.targetVersion, undoStatus: record.undoStatus }, replayed } } };
}

function directOperationKey(input: HomePlanningToolRequest): string {
  return `home-tool:${createHash('sha256').update(stableJson({ v: 1, ownerId: input.ownerId, turnId: input.turnId, requestId: input.requestId, toolName: input.name }), 'utf8').digest('hex')}`;
}
