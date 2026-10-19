import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';

import { HomeConversationCursorInvalidError, HomeConversationInputInvalidError, HomeConversationNotFoundError, HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { HomeProposalDependencyConflictError, HomePlanningScopeConflictError, HomeProposalNotAcceptableError, HomeProposalNotEditableError, HomeProposalNotFoundError, HomeProposalRevisionConflictError } from '@/modules/home-assistant/domain/home-planning-errors';
import type { HomeChangeProposal, HomeProposalCommand, HomeProposalDeadlineResolution, HomeProposalItemState } from '@/modules/home-assistant/domain/home-change-proposal-types';
import type { HomeConversationScope } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IActionLedgerRepository } from '@/modules/action-ledger/repositories/action-ledger-repository';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { IHomeChangeProposalRepository, NewHomeProposalItem } from '@/modules/home-assistant/repositories/home-change-proposal-repository';
import type { ITaskMutationCommands } from '@/modules/tasks/use-cases/task-mutation-use-cases';
import { taskMutationFingerprint } from '@/modules/tasks/use-cases/task-mutation-use-cases';
import type { GetGlobalTaskUseCase } from '@/modules/tasks/use-cases/global-task-query-use-cases';
import type { IWorkspacePlanningUseCases } from '@/modules/projects/use-cases/workspace-planning-use-cases';
import { workspacePlanningFingerprint } from '@/modules/projects/use-cases/workspace-planning-use-cases';
import { normalizeProjectName } from '@/modules/projects/domain/project-root-policy';
import type { Project } from '@/modules/projects/domain/project-types';
import type { HomePlanningToolRequest } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';
import { isCalendarDate, parseProposalToolArgs, resolveDeadlineWithProvenance, stableJson } from '@/modules/home-assistant/use-cases/home-planning-command-validation';
import type { HomeProposalDraftCreator } from '@/modules/home-assistant/use-cases/home-planning-tool-request-handler';
import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';

const MAX_PROPOSAL_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface HomeProposalExecutionItem {
  readonly itemId: string;
  readonly state: HomeProposalItemState;
  readonly receiptId: string | null;
  readonly resultCode: string | null;
}

export interface HomeProposalExecutionResult {
  readonly proposal: HomeChangeProposal;
  readonly execution: { readonly state: 'completed' | 'partial' | 'unknown' | 'cancelled'; readonly items: readonly HomeProposalExecutionItem[] };
  readonly replayed: boolean;
}

export interface IActionLedgerLookup {
  findForOwner(ownerId: string, operationKey: string): Promise<ActionLedgerRecord | null>;
}

export class HomeChangeProposalUseCases implements HomeProposalDraftCreator {
  public constructor(
    private readonly conversations: IHomeConversationRepository,
    private readonly proposals: IHomeChangeProposalRepository,
    private readonly taskQuery: GetGlobalTaskUseCase,
    private readonly taskMutations: ITaskMutationCommands,
    private readonly workspaces: IWorkspacePlanningUseCases,
    private readonly ledger: IActionLedgerLookup,
    private readonly timeZone?: string,
    private readonly createId: () => string = randomUUID
  ) {}

  public async createFromTool(input: HomePlanningToolRequest, value: { readonly items: readonly unknown[] }): Promise<{ readonly id: string; readonly revision: number; readonly itemCount: number }> {
    const conversation = await this.conversations.findForOwner(input.ownerId, input.conversationId);
    const turn = await this.conversations.findTurnForOwner(input.ownerId, input.conversationId, input.turnId);
    if (!conversation) throw new HomeConversationNotFoundError();
    if (!turn) throw new HomeTurnNotFoundError();
    if (turn.status !== 'running' || conversation.scope.kind !== input.scope.kind
      || (input.scope.kind === 'workspace' && conversation.scope.kind === 'workspace' && input.scope.workspaceId !== conversation.scope.workspaceId)) {
      throw new HomePlanningScopeConflictError();
    }
    await this.assertScopeResource(input.ownerId, conversation.scope);
    const parsed = parseProposalToolArgs(value);
    const requestFingerprint = digest(stableJson({ v: 1, scope: conversation.scope, items: parsed.items }));
    const items = await this.normalizeDraftItems(input.ownerId, conversation.scope, parsed.items);
    assertUniqueTargets(items);
    const commandBytes = Buffer.byteLength(stableJson(items.map((item) => item.command)), 'utf8');
    if (commandBytes < 1 || commandBytes > MAX_PROPOSAL_BYTES) throw new HomeConversationInputInvalidError('The Home proposal exceeds the 128 KiB command limit.');
    const proposalId = this.createId();
    const result = await this.proposals.createDraft({
      id: proposalId,
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      sourceTurnId: input.turnId,
      scope: conversation.scope,
      requestId: input.requestId,
      requestFingerprint,
      commandBytes,
      items
    });
    return { id: result.proposal.id, revision: result.proposal.revision, itemCount: result.proposal.itemCount };
  }

  public async list(input: { readonly ownerId: string; readonly conversationId: string; readonly state?: HomeChangeProposal['state']; readonly limit: number; readonly cursor?: string }) {
    const before = input.cursor === undefined ? undefined : decodeCursor(input.cursor, input.ownerId, input.conversationId);
    const page = await this.proposals.listForOwner({
      ownerId: input.ownerId, conversationId: input.conversationId, limit: input.limit,
      ...(input.state ? { state: input.state } : {}), ...(before ? { before } : {})
    });
    if (!page) throw new HomeConversationNotFoundError();
    return {
      proposals: page.proposals.map(({ id, sourceTurnId, state, revision, itemCount, createdAt, updatedAt }) => ({ id, sourceTurnId, state, revision, itemCount, createdAt, updatedAt })),
      nextCursor: page.lastPosition ? encodeCursor(input.ownerId, input.conversationId, page.lastPosition) : null
    };
  }

  public async get(ownerId: string, conversationId: string, proposalId: string): Promise<HomeChangeProposal> {
    const proposal = await this.proposals.getForOwner(ownerId, conversationId, proposalId);
    if (!proposal) throw new HomeProposalNotFoundError();
    return proposal;
  }

  public async editItem(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string; readonly itemId: string; readonly expectedRevision: number; readonly changes: unknown }): Promise<HomeChangeProposal> {
    const proposal = await this.get(input.ownerId, input.conversationId, input.proposalId);
    if (proposal.state !== 'review_required') throw new HomeProposalNotEditableError();
    if (proposal.revision !== input.expectedRevision) throw new HomeProposalRevisionConflictError();
    const item = proposal.items.find((entry) => entry.id === input.itemId);
    if (!item) throw new HomeProposalNotFoundError();
    const edited = await this.applyEdit(proposal, item.command, item.deadlineResolution, input.changes);
    const { command, deadlineResolution } = edited;
    const identity = targetIdentity(command);
    const newItems = proposal.items.map((entry) => entry.id === item.id ? { ...entry, command, deadlineResolution, ...identity } : entry);
    assertUniqueTargets(newItems);
    const commandBytes = Buffer.byteLength(stableJson(newItems.map((entry) => entry.command)), 'utf8');
    if (commandBytes < 1 || commandBytes > MAX_PROPOSAL_BYTES) throw new HomeConversationInputInvalidError('The Home proposal exceeds the 128 KiB command limit.');
    const updated = await this.proposals.editItem({
      ownerId: input.ownerId, conversationId: input.conversationId, proposalId: input.proposalId, itemId: input.itemId,
      expectedRevision: input.expectedRevision, command, targetKind: identity.targetKind, targetId: identity.targetId,
      expectedVersion: identity.expectedVersion, commandBytes, deadlineResolution
    });
    if (!updated) throw new HomeProposalNotFoundError();
    return updated;
  }

  public async removeItem(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string; readonly itemId: string; readonly expectedRevision: number }): Promise<HomeChangeProposal> {
    const proposal = await this.get(input.ownerId, input.conversationId, input.proposalId);
    if (proposal.state !== 'review_required') throw new HomeProposalNotEditableError();
    if (proposal.revision !== input.expectedRevision) throw new HomeProposalRevisionConflictError();
    if (!proposal.items.some((entry) => entry.id === input.itemId)) throw new HomeProposalNotFoundError();
    const commandBytes = Buffer.byteLength(stableJson(proposal.items.filter((entry) => entry.id !== input.itemId).map((entry) => entry.command)), 'utf8');
    const updated = await this.proposals.removeItem({ ...input, commandBytes });
    if (!updated) throw new HomeProposalNotFoundError();
    return updated;
  }

  public async accept(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string; readonly expectedRevision: number }): Promise<HomeProposalExecutionResult> {
    let proposal = await this.get(input.ownerId, input.conversationId, input.proposalId);
    if (proposal.state !== 'review_required') {
      if (proposal.state === 'cancelled' || proposal.acceptanceId === null) throw new HomeProposalNotAcceptableError();
      if (proposal.acceptedRevision !== input.expectedRevision) throw new HomeProposalRevisionConflictError();
      return this.summary(proposal, true);
    }
    if (proposal.revision !== input.expectedRevision) throw new HomeProposalRevisionConflictError();
    if (proposal.items.length === 0) throw new HomeProposalNotAcceptableError();
    const acceptanceId = this.createId();
    const createdWorkspaceIds = new Set<string>();
    const sealed: { readonly itemId: string; readonly operationKey: string; readonly requestFingerprint: string; readonly command: HomeProposalCommand; readonly deadlineResolution: HomeProposalDeadlineResolution | null }[] = [];
    try {
      await this.assertScopeResource(input.ownerId, proposal.scope);
      for (const item of proposal.items) {
        const command = await this.revalidateForAcceptance(input.ownerId, proposal.scope, item.command, createdWorkspaceIds);
        const identity = await this.canonicalIdentity(input.ownerId, proposal.scope, proposal.id, acceptanceId, proposal.sourceTurnId, item.id, command);
        sealed.push({ itemId: item.id, operationKey: identity.operationKey, requestFingerprint: identity.requestFingerprint, command, deadlineResolution: item.deadlineResolution });
        if (command.action === 'workspace.create') createdWorkspaceIds.add(command.workspaceId);
      }
    } catch (error) {
      let current: HomeChangeProposal;
      try {
        current = await this.get(input.ownerId, input.conversationId, input.proposalId);
      } catch {
        throw error;
      }
      if (current.acceptanceId !== null && current.acceptedRevision === input.expectedRevision) return this.summary(current, true);
      throw error;
    }
    proposal = await this.proposals.seal({
      ownerId: input.ownerId, conversationId: input.conversationId, proposalId: input.proposalId,
      expectedRevision: input.expectedRevision, acceptanceId, items: sealed
    }) ?? (await this.get(input.ownerId, input.conversationId, input.proposalId));
    if (proposal.acceptanceId !== acceptanceId) {
      if (proposal.state !== 'cancelled' && proposal.acceptedRevision === input.expectedRevision && proposal.acceptanceId !== null) return this.summary(proposal, true);
      throw new HomeProposalRevisionConflictError();
    }
    return this.executeAccepted(proposal, false);
  }

  public async execute(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string }): Promise<HomeProposalExecutionResult> {
    const proposal = await this.get(input.ownerId, input.conversationId, input.proposalId);
    if (!['accepted', 'executing', 'partial', 'unknown'].includes(proposal.state)) throw new HomeProposalNotAcceptableError();
    return this.executeAccepted(proposal, true);
  }

  public async cancel(input: { readonly ownerId: string; readonly conversationId: string; readonly proposalId: string; readonly expectedRevision: number }): Promise<HomeChangeProposal> {
    const proposal = await this.proposals.cancel(input);
    if (!proposal) throw new HomeProposalNotFoundError();
    return proposal;
  }

  private async normalizeDraftItems(ownerId: string, scope: HomeConversationScope, rawItems: readonly unknown[]): Promise<readonly NewHomeProposalItem[]> {
    const workspaceIds: string[] = [];
    const items: NewHomeProposalItem[] = [];
    for (const [index, raw] of rawItems.entries()) {
      const row = raw as Record<string, unknown>;
      const itemId = this.createId();
      let command: HomeProposalCommand;
      let deadlineResolution: HomeProposalDeadlineResolution | null = null;
      if (row.action === 'workspace.create') {
        if (scope.kind !== 'home') throw new HomePlanningScopeConflictError();
        const identity = normalizeProjectName(row.name);
        const workspaceId = this.createId();
        workspaceIds[index] = workspaceId;
        command = { action: 'workspace.create', workspaceId, name: identity.name, objective: normalizeObjective(row.objective) };
      } else if (row.action === 'task.create') {
        const workspaceId = row.workspaceId === undefined && scope.kind === 'workspace'
          ? scope.workspaceId
          : await this.resolveWorkspaceId(ownerId, scope, row.workspaceId, index, workspaceIds);
        const taskId = this.createId();
        const deadline = resolveDeadlineWithProvenance(row.deadline ?? null, this.timeZone);
        deadlineResolution = deadline.deadlineResolution;
        command = {
          action: 'task.create', taskId,
          title: String(row.title).trim(), details: normalizeOptionalText(row.details), workspaceId,
          importance: String(row.importance ?? 'medium'), deadline: deadline.deadline,
          subtasks: normalizeCreateSubtasks(row.subtasks),
          ...(row.expectedOrderVersion === undefined ? {} : { expectedOrderVersion: row.expectedOrderVersion as number })
        };
      } else if (row.action === 'task.update') {
        const taskId = row.taskId as string;
        const current = await this.scopedTask(ownerId, scope, taskId);
        assertExpectedVersion(current.task.version, row.expectedVersion as number);
        const deadline = row.deadline === undefined ? null : resolveDeadlineWithProvenance(row.deadline, this.timeZone);
        deadlineResolution = deadline?.deadlineResolution ?? null;
        command = {
          action: 'task.update', taskId, expectedVersion: row.expectedVersion as number,
          ...(row.title === undefined ? {} : { title: String(row.title).trim() }),
          ...(row.details === undefined ? {} : { details: normalizeOptionalText(row.details) }),
          ...(row.status === undefined ? {} : { status: row.status as string }),
          ...(row.importance === undefined ? {} : { importance: row.importance as string }),
          ...(deadline === null ? {} : { deadline: deadline.deadline }),
          ...(row.subtasks === undefined ? {} : { subtasks: normalizePatchSubtasks(row.subtasks, current.task.subtasks.map((subtask) => subtask.id)) })
        };
      } else if (row.action === 'task.move') {
        const taskId = row.taskId as string;
        const current = await this.scopedTask(ownerId, scope, taskId);
        assertExpectedVersion(current.task.version, row.expectedVersion as number);
        const destination = await this.resolveWorkspaceId(ownerId, scope, row.workspaceId, index, workspaceIds, true);
        command = { action: 'task.move', taskId, expectedVersion: row.expectedVersion as number, workspaceId: destination };
      } else if (row.action === 'workspace.update_objective') {
        const workspaceId = row.workspaceId as string;
        const project = await this.scopedWorkspace(ownerId, scope, workspaceId);
        assertExpectedVersion(project.version, row.expectedVersion as number);
        command = { action: 'workspace.update_objective', workspaceId, expectedVersion: row.expectedVersion as number, objective: normalizeObjective(row.objective) };
      } else {
        throw new HomeConversationInputInvalidError('The Home proposal action is invalid.');
      }
      const identity = targetIdentity(command);
      items.push({ id: itemId, position: index, action: command.action, targetKind: identity.targetKind, targetId: identity.targetId, expectedVersion: identity.expectedVersion, command, deadlineResolution });
    }
    return items;
  }

  private async resolveWorkspaceId(ownerId: string, scope: HomeConversationScope, value: unknown, itemIndex: number, created: readonly string[], allowNull = true): Promise<string | null> {
    if (value === null || value === undefined) {
      if (!allowNull || scope.kind === 'workspace') throw new HomePlanningScopeConflictError();
      return null;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'workspaceRef' in value) {
      const reference = (value as { workspaceRef: number }).workspaceRef;
      const resolved = created[reference - 1];
      if (!resolved || reference < 1 || reference > itemIndex) throw new HomeConversationInputInvalidError('A workspace reference must point to an earlier workspace.create item.');
      return resolved;
    }
    if (typeof value !== 'string') throw new HomeConversationInputInvalidError('The workspace target is invalid.');
    await this.scopedWorkspace(ownerId, scope, value);
    return value;
  }

  private async scopedTask(ownerId: string, scope: HomeConversationScope, taskId: string) {
    const result = await this.taskQuery.execute({ ownerId, taskId, includeArchived: false });
    if (scope.kind === 'workspace' && (result.task.projectId !== scope.workspaceId || result.workspace?.status !== 'active')) throw new HomePlanningScopeConflictError();
    if (result.workspace?.status === 'archived') throw new HomePlanningScopeConflictError();
    return result;
  }

  private async scopedWorkspace(ownerId: string, scope: HomeConversationScope, workspaceId: string): Promise<Project> {
    const project = await this.workspaces.reuse({ ownerId, projectId: workspaceId });
    if (scope.kind === 'workspace' && (scope.workspaceId !== project.id || project.relativeRoot !== null)) throw new HomePlanningScopeConflictError();
    return project;
  }

  private async assertScopeResource(ownerId: string, scope: HomeConversationScope): Promise<void> {
    if (scope.kind === 'workspace') await this.scopedWorkspace(ownerId, scope, scope.workspaceId);
  }

  private async revalidateForAcceptance(ownerId: string, scope: HomeConversationScope, command: HomeProposalCommand, priorCreatedWorkspaceIds: ReadonlySet<string>): Promise<HomeProposalCommand> {
    if (command.action === 'task.create') {
      if (command.workspaceId && !priorCreatedWorkspaceIds.has(command.workspaceId)) await this.scopedWorkspace(ownerId, scope, command.workspaceId);
      else if (scope.kind === 'workspace') throw new HomePlanningScopeConflictError();
      return command;
    }
    if (command.action === 'workspace.create') {
      if (scope.kind !== 'home') throw new HomePlanningScopeConflictError();
      return command;
    }
    if (command.action === 'task.update' || command.action === 'task.move') {
      const current = await this.scopedTask(ownerId, scope, command.taskId);
      assertExpectedVersion(current.task.version, command.expectedVersion);
      if (command.action === 'task.move' && command.workspaceId && !priorCreatedWorkspaceIds.has(command.workspaceId)) await this.scopedWorkspace(ownerId, scope, command.workspaceId);
      return command;
    }
    const project = await this.scopedWorkspace(ownerId, scope, command.workspaceId);
    assertExpectedVersion(project.version, command.expectedVersion);
    return command;
  }

  private async canonicalIdentity(ownerId: string, scope: HomeConversationScope, proposalId: string, acceptanceId: string, turnId: string, itemId: string, command: HomeProposalCommand) {
    const operationKey = `home-proposal:${digest(stableJson({ v: 1, ownerId, proposalId, acceptanceId, itemId }))}`;
    if (command.action === 'task.create') {
      const request = { ownerId, projectId: command.workspaceId, taskId: command.taskId, operationKey, actorKind: 'assistant' as const, turnId, title: command.title, details: command.details, importance: command.importance, deadline: command.deadline, subtasks: command.subtasks, ...(command.expectedOrderVersion === undefined ? {} : { expectedOrderVersion: command.expectedOrderVersion }) };
      return { operationKey, requestFingerprint: taskMutationFingerprint('task.create', request) };
    }
    if (command.action === 'task.update') {
      const current = await this.scopedTask(ownerId, scope, command.taskId);
      const request = { ownerId, taskId: command.taskId, expectedVersion: command.expectedVersion, ...(current.task.projectId ? { expectedProjectId: current.task.projectId } : {}), operationKey, actorKind: 'assistant' as const, turnId, ...(command.title === undefined ? {} : { title: command.title }), ...(command.details === undefined ? {} : { details: command.details }), ...(command.status === undefined ? {} : { status: command.status }), ...(command.importance === undefined ? {} : { importance: command.importance }), ...(command.deadline === undefined ? {} : { deadline: command.deadline }), ...(command.subtasks === undefined ? {} : { subtasks: command.subtasks }) };
      return { operationKey, requestFingerprint: taskMutationFingerprint('task.update', request) };
    }
    if (command.action === 'task.move') {
      const request = { ownerId, taskId: command.taskId, expectedVersion: command.expectedVersion, workspaceId: command.workspaceId, operationKey, actorKind: 'assistant' as const, turnId };
      return { operationKey, requestFingerprint: taskMutationFingerprint('task.move', request) };
    }
    if (command.action === 'workspace.create') {
      const request = { ownerId, projectId: command.workspaceId, operationKey, name: command.name, objective: command.objective, actorKind: 'assistant' as const, turnId };
      return { operationKey, requestFingerprint: workspacePlanningFingerprint('workspace.create', request) };
    }
    const request = { ownerId, projectId: command.workspaceId, expectedVersion: command.expectedVersion, operationKey, objective: command.objective, actorKind: 'assistant' as const, turnId };
    return { operationKey, requestFingerprint: workspacePlanningFingerprint('workspace.update', request) };
  }

  private async executeAccepted(proposal: HomeChangeProposal, replayed: boolean): Promise<HomeProposalExecutionResult> {
    const ownerId = proposal.ownerId;
    const conversationId = proposal.conversationId;
    const proposalId = proposal.id;
    if (!proposal.acceptanceId) throw new HomeProposalNotAcceptableError();
    if (proposal.state === 'completed' || proposal.state === 'cancelled') return this.summary(proposal, true);
    await this.proposals.updateExecutionState({ ownerId, conversationId, proposalId, state: 'executing' });
    let stopped = false;
    let uncertain = false;
    const failedWorkspaceIds = new Set<string>();
    for (const item of proposal.items) {
      if (stopped) break;
      if (item.state === 'saved' && item.receiptId) continue;
      if (item.state === 'failed' || item.state === 'conflicted' || item.state === 'blocked' || item.state === 'cancelled') {
        if (item.action === 'workspace.create') failedWorkspaceIds.add(item.targetId);
        continue;
      }
      if (isWorkspaceDependent(item.command) && failedWorkspaceIds.has(isWorkspaceDependent(item.command)!)) {
        await this.proposals.updateItemState({ ownerId, conversationId, proposalId, itemId: item.id, state: 'blocked', resultCode: 'DEPENDENCY_FAILED' });
        if (item.action === 'workspace.create') failedWorkspaceIds.add(item.targetId);
        continue;
      }
      const operationKey = item.operationKey;
      const requestFingerprint = item.requestFingerprint;
      if (!operationKey || !requestFingerprint) throw new HomeProposalNotAcceptableError();
      const prior = await this.ledger.findForOwner(ownerId, operationKey);
      if (prior) {
        if (matchesReceipt(item, prior, requestFingerprint)) {
          await this.proposals.updateItemState({ ownerId, conversationId, proposalId, itemId: item.id, state: 'saved', receiptId: prior.id });
          continue;
        }
        await this.proposals.updateItemState({ ownerId, conversationId, proposalId, itemId: item.id, state: 'conflicted', resultCode: 'ACTION_IDENTITY_CONFLICT' });
        if (item.action === 'workspace.create') failedWorkspaceIds.add(item.targetId);
        continue;
      }
      try {
        await this.proposals.updateItemState({ ownerId, conversationId, proposalId, itemId: item.id, state: 'executing' });
        await this.applyCanonical(ownerId, proposal.sourceTurnId, proposalId, item);
      } catch (error: unknown) {
        if (hasCode(error, 'HOME_PROPOSAL_ALREADY_CANCELLED')) { stopped = true; break; }
        let resolved: ActionLedgerRecord | null = null;
        try { resolved = await this.ledger.findForOwner(ownerId, operationKey); } catch { /* Outcome remains unknown if the ledger cannot be checked. */ }
        if (resolved && matchesReceipt(item, resolved, requestFingerprint)) {
          await this.proposals.updateItemState({ ownerId, conversationId, proposalId, itemId: item.id, state: 'saved', receiptId: resolved.id });
          continue;
        }
        const code = errorCode(error);
        if (resolved) {
          await this.proposals.updateItemState({ ownerId, conversationId, proposalId, itemId: item.id, state: 'conflicted', resultCode: 'ACTION_IDENTITY_CONFLICT' });
          if (item.action === 'workspace.create') failedWorkspaceIds.add(item.targetId);
          continue;
        }
        if (code) {
          const state: HomeProposalItemState = isConflictCode(code) ? 'conflicted' : 'failed';
          await this.proposals.updateItemState({ ownerId, conversationId, proposalId, itemId: item.id, state, resultCode: code });
          if (item.action === 'workspace.create') failedWorkspaceIds.add(item.targetId);
          continue;
        }
        uncertain = true;
        stopped = true;
        try { await this.proposals.updateItemState({ ownerId, conversationId, proposalId, itemId: item.id, state: 'unknown', resultCode: 'OUTCOME_UNKNOWN' }); } catch { /* A lost persistence channel is reported by the next explicit read. */ }
      }
    }
    const latest = await this.get(ownerId, conversationId, proposalId);
    if (latest.state === 'cancelled') return this.summary(latest, replayed);
    const hasUnresolved = latest.items.some((item) => ['ready', 'executing', 'unknown'].includes(item.state));
    const hasFailures = latest.items.some((item) => ['failed', 'conflicted', 'blocked', 'cancelled'].includes(item.state));
    const state = uncertain || hasUnresolved ? 'unknown' : hasFailures ? 'partial' : 'completed';
    const updated = await this.proposals.updateExecutionState({ ownerId, conversationId, proposalId, state }) ?? latest;
    return this.summary(updated, replayed);
  }

  private async applyCanonical(ownerId: string, turnId: string, proposalId: string, item: HomeChangeProposal['items'][number]): Promise<void> {
    const context = { kind: 'home_proposal_item' as const, proposalId, itemId: item.id };
    const operationKey = item.operationKey as string;
    const command = item.command;
    if (command.action === 'task.create') {
      await this.taskMutations.create({ ownerId, taskId: command.taskId, projectId: command.workspaceId, operationKey, actorKind: 'assistant', turnId, eventContext: context, title: command.title, details: command.details, importance: command.importance, deadline: command.deadline, subtasks: command.subtasks, ...(command.expectedOrderVersion === undefined ? {} : { expectedOrderVersion: command.expectedOrderVersion }) });
    } else if (command.action === 'task.update') {
      const current = await this.scopedTask(ownerId, { kind: 'home' }, command.taskId);
      await this.taskMutations.update({ ownerId, taskId: command.taskId, expectedVersion: command.expectedVersion, ...(current.task.projectId ? { expectedProjectId: current.task.projectId } : {}), operationKey, actorKind: 'assistant', turnId, eventContext: context, ...(command.title === undefined ? {} : { title: command.title }), ...(command.details === undefined ? {} : { details: command.details }), ...(command.status === undefined ? {} : { status: command.status }), ...(command.importance === undefined ? {} : { importance: command.importance }), ...(command.deadline === undefined ? {} : { deadline: command.deadline }), ...(command.subtasks === undefined ? {} : { subtasks: command.subtasks }) });
    } else if (command.action === 'task.move') {
      await this.taskMutations.move({ ownerId, taskId: command.taskId, expectedVersion: command.expectedVersion, workspaceId: command.workspaceId, operationKey, actorKind: 'assistant', turnId, eventContext: context });
    } else if (command.action === 'workspace.create') {
      await this.workspaces.createPlanning({ ownerId, projectId: command.workspaceId, operationKey, name: command.name, objective: command.objective, actorKind: 'assistant', turnId, eventContext: context });
    } else {
      await this.workspaces.updateObjective({ ownerId, projectId: command.workspaceId, expectedVersion: command.expectedVersion, operationKey, objective: command.objective, actorKind: 'assistant', turnId, eventContext: context });
    }
  }

  private async summary(proposal: HomeChangeProposal, replayed: boolean): Promise<HomeProposalExecutionResult> {
    const state = proposal.state === 'cancelled' ? 'cancelled'
      : proposal.state === 'completed' ? 'completed'
        : proposal.state === 'partial' ? 'partial' : 'unknown';
    return {
      proposal,
      execution: { state, items: proposal.items.map(({ id, state: itemState, receiptId, resultCode }) => ({ itemId: id, state: itemState, receiptId, resultCode })) },
      replayed
    };
  }

  private async applyEdit(proposal: HomeChangeProposal, current: HomeProposalCommand, currentDeadlineResolution: HomeProposalDeadlineResolution | null, changes: unknown): Promise<{ readonly command: HomeProposalCommand; readonly deadlineResolution: HomeProposalDeadlineResolution | null }> {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new HomeConversationInputInvalidError('Proposal changes must be an object.');
    const entries = Object.entries(changes as Record<string, unknown>);
    if (entries.length === 0) throw new HomeConversationInputInvalidError('Provide at least one proposal field to edit.');
    const allowed = editableFields(current.action);
    if (entries.some(([key]) => !allowed.has(key))) throw new HomeConversationInputInvalidError('One or more fields cannot be edited for this proposal item.');
    const hasDeadlineChange = entries.some(([key]) => key === 'deadline');
    const candidate = { ...current, ...(changes as Record<string, unknown>) } as HomeProposalCommand;
    if (candidate.action === 'task.create') {
      const ws = await this.resolveWorkspaceId(proposal.ownerId, proposal.scope, candidate.workspaceId, currentPosition(proposal, current), proposal.items.map((entry) => entry.command.action === 'workspace.create' ? entry.targetId : ''), true);
      const deadline = hasDeadlineChange ? resolveEditedDeadline(candidate.deadline, this.timeZone) : { deadline: candidate.deadline, deadlineResolution: currentDeadlineResolution };
      const command: HomeProposalCommand = { ...candidate, title: String(candidate.title).trim(), details: normalizeOptionalText(candidate.details), workspaceId: ws, deadline: deadline.deadline, subtasks: normalizeCreateSubtasks(candidate.subtasks) };
      if (ws) await this.scopedWorkspace(proposal.ownerId, proposal.scope, ws);
      else if (proposal.scope.kind === 'workspace') throw new HomePlanningScopeConflictError();
      return { command, deadlineResolution: deadline.deadlineResolution };
    }
    if (candidate.action === 'task.update') {
      if (candidate.status !== undefined && [candidate.title, candidate.details, candidate.importance, candidate.deadline, candidate.subtasks].some((field) => field !== undefined)) throw new HomeConversationInputInvalidError('Status must be the only update field.');
      const currentTask = await this.scopedTask(proposal.ownerId, proposal.scope, candidate.taskId);
      assertExpectedVersion(currentTask.task.version, candidate.expectedVersion);
      const deadline = hasDeadlineChange ? resolveEditedDeadline(candidate.deadline, this.timeZone) : { deadline: candidate.deadline, deadlineResolution: currentDeadlineResolution };
      const command: HomeProposalCommand = { ...candidate, ...(candidate.title === undefined ? {} : { title: candidate.title.trim() }), ...(candidate.details === undefined ? {} : { details: normalizeOptionalText(candidate.details) }), ...(hasDeadlineChange ? { deadline: deadline.deadline } : {}), ...(candidate.subtasks === undefined ? {} : { subtasks: normalizePatchSubtasks(candidate.subtasks, currentTask.task.subtasks.map((subtask) => subtask.id)) }) };
      return { command, deadlineResolution: deadline.deadlineResolution };
    }
    if (candidate.action === 'task.move') {
      const currentTask = await this.scopedTask(proposal.ownerId, proposal.scope, candidate.taskId);
      assertExpectedVersion(currentTask.task.version, candidate.expectedVersion);
      const workspaceId = await this.resolveWorkspaceId(proposal.ownerId, proposal.scope, candidate.workspaceId, currentPosition(proposal, current), proposal.items.map((entry) => entry.command.action === 'workspace.create' ? entry.targetId : ''), true);
      return { command: { ...candidate, workspaceId }, deadlineResolution: null };
    }
    if (candidate.action === 'workspace.create') {
      const identity = normalizeProjectName(candidate.name);
      return { command: { ...candidate, name: identity.name, objective: normalizeObjective(candidate.objective) }, deadlineResolution: null };
    }
    const workspace = await this.scopedWorkspace(proposal.ownerId, proposal.scope, candidate.workspaceId);
    assertExpectedVersion(workspace.version, candidate.expectedVersion);
    return { command: { ...candidate, objective: normalizeObjective(candidate.objective) }, deadlineResolution: null };
  }
}

function normalizeCreateSubtasks(value: unknown): readonly { readonly title: string; readonly completed: boolean }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HomeConversationInputInvalidError('The task checklist is invalid.');
  return value.map((raw) => {
    const item = raw as Record<string, unknown>;
    return { title: String(item.title).trim(), completed: item.completed === true };
  });
}

function normalizePatchSubtasks(value: unknown, existingIds: readonly string[]): readonly { readonly id: string; readonly title: string; readonly completed: boolean }[] {
  if (!Array.isArray(value)) throw new HomeConversationInputInvalidError('The task checklist is invalid.');
  const existing = new Set(existingIds);
  return value.map((raw) => {
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : randomUUID();
    if (item.id !== undefined && !existing.has(id)) throw new HomeConversationInputInvalidError('A checklist item does not belong to this task.');
    return { id, title: String(item.title).trim(), completed: item.completed === true };
  });
}

function normalizeOptionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HomeConversationInputInvalidError('The task or workspace text is invalid.');
  const normalized = value.trim();
  return normalized || null;
}

function resolveEditedDeadline(value: unknown, timeZone: string | undefined): { readonly deadline: string | null; readonly deadlineResolution: HomeProposalDeadlineResolution | null } {
  if (typeof value !== 'string') return resolveDeadlineWithProvenance(value, timeZone);
  if (!isCalendarDate(value)) throw new HomeConversationInputInvalidError('Choose a valid calendar date.');
  return { deadline: value, deadlineResolution: null };
}

function normalizeObjective(value: unknown): string | null {
  return normalizeOptionalText(value);
}

function assertExpectedVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new HomeProposalRevisionConflictError();
}

function targetIdentity(command: HomeProposalCommand): { readonly targetKind: 'task' | 'workspace'; readonly targetId: string; readonly expectedVersion: number | null } {
  if (command.action === 'task.create') {
    return { targetKind: 'task', targetId: command.taskId, expectedVersion: null };
  }
  if (command.action === 'task.update' || command.action === 'task.move') {
    return { targetKind: 'task', targetId: command.taskId, expectedVersion: command.expectedVersion };
  }
  if (command.action === 'workspace.create') return { targetKind: 'workspace', targetId: command.workspaceId, expectedVersion: null };
  return { targetKind: 'workspace', targetId: command.workspaceId, expectedVersion: command.expectedVersion };
}

function assertUniqueTargets(items: readonly { readonly targetKind: 'task' | 'workspace'; readonly targetId: string; readonly action: HomeProposalCommand['action'] }[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.action === 'task.create' || item.action === 'workspace.create') continue;
    const key = `${item.targetKind}:${item.targetId}`;
    if (seen.has(key)) throw new HomeConversationInputInvalidError('A proposal may change each existing target only once.');
    seen.add(key);
  }
}

function editableFields(action: HomeProposalCommand['action']): ReadonlySet<string> {
  switch (action) {
    case 'task.create': return new Set(['title', 'details', 'workspaceId', 'importance', 'deadline', 'subtasks', 'expectedOrderVersion']);
    case 'task.update': return new Set(['taskId', 'expectedVersion', 'title', 'details', 'status', 'importance', 'deadline', 'subtasks']);
    case 'task.move': return new Set(['taskId', 'expectedVersion', 'workspaceId']);
    case 'workspace.create': return new Set(['name', 'objective']);
    case 'workspace.update_objective': return new Set(['workspaceId', 'expectedVersion', 'objective']);
  }
}

function currentPosition(proposal: HomeChangeProposal, command: HomeProposalCommand): number {
  return proposal.items.find((item) => item.command === command)?.position ?? -1;
}

function isWorkspaceDependent(command: HomeProposalCommand): string | null {
  if ((command.action === 'task.create' || command.action === 'task.move') && command.workspaceId) return command.workspaceId;
  return null;
}

function matchesReceipt(item: HomeChangeProposal['items'][number], record: ActionLedgerRecord, fingerprint: string): boolean {
  return record.requestFingerprint === fingerprint && record.targetKind === item.targetKind && record.targetId === item.targetId
    && record.expectedVersion === item.expectedVersion && record.actionKind === ledgerActionKind(item.action);
}

function ledgerActionKind(action: HomeProposalCommand['action']): ActionLedgerRecord['actionKind'] {
  return action === 'workspace.update_objective' ? 'workspace.update' : action;
}

function isConflictCode(code: string): boolean {
  return /(?:VERSION|CONFLICT|ARCHIVED|NOT_FOUND|NOT_AVAILABLE|REUSED)/u.test(code);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { code?: unknown; statusCode?: unknown };
  if (typeof value.code !== 'string' || !/^[A-Z0-9_:-]{1,80}$/u.test(value.code)) return null;
  if (typeof value.statusCode === 'number' && value.statusCode >= 500) return null;
  return value.code;
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === code);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function encodeCursor(ownerId: string, conversationId: string, position: { readonly createdAt: string; readonly id: string }): string {
  return Buffer.from(stableJson({ v: 1, ownerId, conversationId, createdAt: position.createdAt, id: position.id }), 'utf8').toString('base64url');
}

function decodeCursor(value: string, ownerId: string, conversationId: string): { readonly createdAt: string; readonly id: string } {
  if (value.length > 1024) throw new HomeConversationCursorInvalidError();
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (decoded.v !== 1 || decoded.ownerId !== ownerId || decoded.conversationId !== conversationId
      || typeof decoded.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(decoded.createdAt)
      || typeof decoded.id !== 'string' || !UUID.test(decoded.id)) throw new Error('invalid');
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new HomeConversationCursorInvalidError();
  }
}
