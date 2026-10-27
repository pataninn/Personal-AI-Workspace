import { ApiClientError, getJson, patchJson, postJson, requestJson } from '@/shared/api';
import type { HomeConversationScope } from '@/entities/home-conversation/model/types';

const PROPOSALS_PATH = '/api/v1/home/conversations';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type HomeProposalState = 'review_required' | 'accepted' | 'executing' | 'partial' | 'completed' | 'cancelled' | 'unknown';
export type HomeProposalItemState = 'ready' | 'executing' | 'saved' | 'failed' | 'conflicted' | 'blocked' | 'cancelled' | 'unknown';
export type HomeProposalAction = 'task.create' | 'task.update' | 'task.move' | 'workspace.create' | 'workspace.update_objective';
export type HomeProposalImportance = 'low' | 'medium' | 'high' | 'urgent';

export type HomeProposalCommand =
  | { readonly action: 'task.create'; readonly taskId: string; readonly title: string; readonly details: string | null; readonly workspaceId: string | null; readonly importance: HomeProposalImportance; readonly deadline: string | null; readonly subtasks: readonly { readonly id?: string; readonly title: string; readonly completed?: boolean }[]; readonly expectedOrderVersion?: number }
  | { readonly action: 'task.update'; readonly taskId: string; readonly expectedVersion: number; readonly title?: string; readonly details?: string | null; readonly status?: string; readonly importance?: HomeProposalImportance; readonly deadline?: string | null; readonly subtasks?: readonly { readonly id: string; readonly title: string; readonly completed: boolean }[] }
  | { readonly action: 'task.move'; readonly taskId: string; readonly expectedVersion: number; readonly workspaceId: string | null }
  | { readonly action: 'workspace.create'; readonly workspaceId: string; readonly name: string; readonly objective: string | null }
  | { readonly action: 'workspace.update_objective'; readonly workspaceId: string; readonly expectedVersion: number; readonly objective: string | null };

export interface HomeProposalDeadlineResolution {
  readonly timeZone: string;
  readonly source: 'configured' | 'utc-fallback';
}

export interface HomeProposalItem {
  readonly id: string;
  readonly position: number;
  readonly action: HomeProposalAction;
  readonly command: HomeProposalCommand;
  readonly deadlineResolution: HomeProposalDeadlineResolution | null;
  readonly state: HomeProposalItemState;
  readonly receiptId: string | null;
  readonly resultCode: string | null;
}

export interface HomeProposal {
  readonly id: string;
  readonly sourceTurnId: string;
  readonly scope: HomeConversationScope;
  readonly state: HomeProposalState;
  readonly revision: number;
  readonly acceptedRevision: number | null;
  readonly acceptanceId: string | null;
  readonly itemCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: readonly HomeProposalItem[];
}

export interface HomeProposalDescriptor {
  readonly id: string;
  readonly sourceTurnId: string;
  readonly state: HomeProposalState;
  readonly revision: number;
  readonly itemCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HomeProposalPage {
  readonly proposals: readonly HomeProposalDescriptor[];
  readonly nextCursor: string | null;
}

export interface HomeProposalExecution {
  readonly state: 'completed' | 'partial' | 'unknown' | 'cancelled';
  readonly items: readonly { readonly itemId: string; readonly state: HomeProposalItemState; readonly receiptId: string | null; readonly resultCode: string | null }[];
}

export interface HomeProposalMutationResult {
  readonly proposal: HomeProposal;
  readonly execution: HomeProposalExecution;
  readonly replayed: boolean;
}

export interface HomeProposalAcceptanceResult extends HomeProposalMutationResult {
  readonly acceptance: { readonly id: string; readonly revision: number };
}

export async function listHomeProposals(conversationId: string, cursor?: string): Promise<HomeProposalPage> {
  const query = new URLSearchParams({ limit: '50' });
  if (cursor) query.set('cursor', cursor);
  const response = await getJson<unknown>(`${conversationPath(conversationId)}?${query.toString()}`);
  const record = asRecord(response);
  if (!record || !Array.isArray(record.proposals)) throw invalidResponse();
  return { proposals: record.proposals.map(normalizeDescriptor), nextCursor: nullableString(record.nextCursor) };
}

export async function getHomeProposal(conversationId: string, proposalId: string): Promise<HomeProposal> {
  const response = asRecord(await getJson<unknown>(`${conversationPath(conversationId)}/${encodeURIComponent(proposalId)}`));
  if (!response) throw invalidResponse();
  return normalizeProposal(response.proposal);
}

export async function editHomeProposalItem(
  conversationId: string,
  proposalId: string,
  itemId: string,
  expectedRevision: number,
  changes: Readonly<Record<string, unknown>>,
  csrfToken: string
): Promise<HomeProposal> {
  const response = asRecord(await patchJson<unknown>(
    proposalItemPath(conversationId, proposalId, itemId),
    { expectedRevision, changes },
    { 'X-CSRF-Token': csrfToken }
  ));
  if (!response) throw invalidResponse();
  return normalizeProposal(response.proposal);
}

export async function removeHomeProposalItem(
  conversationId: string,
  proposalId: string,
  itemId: string,
  expectedRevision: number,
  csrfToken: string
): Promise<HomeProposal> {
  const response = asRecord(await requestJson<unknown>(proposalItemPath(conversationId, proposalId, itemId), {
    method: 'DELETE',
    headers: { 'If-Match': `"${expectedRevision}"`, 'X-CSRF-Token': csrfToken }
  }));
  if (!response) throw invalidResponse();
  return normalizeProposal(response.proposal);
}

export async function acceptHomeProposal(conversationId: string, proposalId: string, expectedRevision: number, csrfToken: string): Promise<HomeProposalAcceptanceResult> {
  const response = asRecord(await postJson<unknown>(`${conversationPath(conversationId)}/${encodeURIComponent(proposalId)}/acceptance`, { expectedRevision }, { 'X-CSRF-Token': csrfToken }));
  if (!response) throw invalidResponse();
  const acceptance = asRecord(response.acceptance);
  if (!acceptance || !isUuid(acceptance.id) || !isPositiveInteger(acceptance.revision) || typeof response.replayed !== 'boolean') throw invalidResponse();
  return { proposal: normalizeProposal(response.proposal), acceptance: { id: acceptance.id, revision: acceptance.revision }, execution: normalizeExecution(response.execution), replayed: response.replayed };
}

export async function resumeHomeProposal(conversationId: string, proposalId: string, csrfToken: string): Promise<HomeProposalMutationResult> {
  const response = asRecord(await postJson<unknown>(`${conversationPath(conversationId)}/${encodeURIComponent(proposalId)}/execution`, {}, { 'X-CSRF-Token': csrfToken }));
  if (!response || typeof response.replayed !== 'boolean') throw invalidResponse();
  return { proposal: normalizeProposal(response.proposal), execution: normalizeExecution(response.execution), replayed: response.replayed };
}

export async function cancelHomeProposal(conversationId: string, proposalId: string, expectedRevision: number, csrfToken: string): Promise<HomeProposal> {
  const response = asRecord(await postJson<unknown>(`${conversationPath(conversationId)}/${encodeURIComponent(proposalId)}/cancellation`, { expectedRevision }, { 'X-CSRF-Token': csrfToken }));
  if (!response) throw invalidResponse();
  return normalizeProposal(response.proposal);
}

function normalizeDescriptor(value: unknown): HomeProposalDescriptor {
  const item = asRecord(value);
  if (!item || !isUuid(item.id) || !isUuid(item.sourceTurnId) || !isProposalState(item.state) || !isPositiveInteger(item.revision) ||
      !isNonNegativeInteger(item.itemCount) || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string') throw invalidResponse();
  return { id: item.id, sourceTurnId: item.sourceTurnId, state: item.state, revision: item.revision, itemCount: item.itemCount, createdAt: item.createdAt, updatedAt: item.updatedAt };
}

function normalizeProposal(value: unknown): HomeProposal {
  const item = asRecord(value);
  if (!item || !isUuid(item.id) || !isUuid(item.sourceTurnId) || !isProposalState(item.state) || !isPositiveInteger(item.revision) ||
      (item.acceptedRevision !== null && !isPositiveInteger(item.acceptedRevision)) || (item.acceptanceId !== null && !isUuid(item.acceptanceId)) ||
      !isNonNegativeInteger(item.itemCount) || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || !Array.isArray(item.items)) throw invalidResponse();
  return {
    id: item.id,
    sourceTurnId: item.sourceTurnId,
    scope: normalizeScope(item.scope),
    state: item.state,
    revision: item.revision,
    acceptedRevision: item.acceptedRevision as number | null,
    acceptanceId: item.acceptanceId as string | null,
    itemCount: item.itemCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    items: item.items.map(normalizeProposalItem)
  };
}

function normalizeProposalItem(value: unknown): HomeProposalItem {
  const item = asRecord(value);
  if (!item || !isUuid(item.id) || !isNonNegativeInteger(item.position) || !isProposalAction(item.action) || !isProposalItemState(item.state) ||
      (item.receiptId !== null && !isUuid(item.receiptId)) || (item.resultCode !== null && typeof item.resultCode !== 'string')) throw invalidResponse();
  const command = normalizeCommand(item.command);
  if (command.action !== item.action) throw invalidResponse();
  return { id: item.id, position: item.position, action: item.action, command, deadlineResolution: normalizeDeadlineResolution(item.deadlineResolution), state: item.state, receiptId: item.receiptId as string | null, resultCode: item.resultCode as string | null };
}

function normalizeDeadlineResolution(value: unknown): HomeProposalDeadlineResolution | null {
  if (value === undefined || value === null) return null;
  const resolution = asRecord(value);
  if (!resolution || typeof resolution.timeZone !== 'string' || resolution.timeZone.length < 1 || resolution.timeZone.length > 100 ||
      (resolution.source !== 'configured' && resolution.source !== 'utc-fallback') ||
      (resolution.source === 'utc-fallback' && resolution.timeZone !== 'UTC')) throw invalidResponse();
  return { timeZone: resolution.timeZone, source: resolution.source };
}

function normalizeCommand(value: unknown): HomeProposalCommand {
  const command = asRecord(value);
  if (!command || typeof command.action !== 'string') throw invalidResponse();
  if (command.action === 'task.create') {
    if (!isUuid(command.taskId) || typeof command.title !== 'string' || !nullableStringGuard(command.details) || !nullableUuidGuard(command.workspaceId) ||
        !isImportance(command.importance) || !nullableDateGuard(command.deadline) || !Array.isArray(command.subtasks) ||
        (command.expectedOrderVersion !== undefined && !isPositiveInteger(command.expectedOrderVersion))) throw invalidResponse();
    const subtasks = command.subtasks.map((entry) => {
      const subtask = asRecord(entry);
      if (!subtask || typeof subtask.title !== 'string' || (subtask.id !== undefined && !isUuid(subtask.id)) || (subtask.completed !== undefined && typeof subtask.completed !== 'boolean')) throw invalidResponse();
      return { ...(typeof subtask.id === 'string' ? { id: subtask.id } : {}), title: subtask.title, ...(typeof subtask.completed === 'boolean' ? { completed: subtask.completed } : {}) };
    });
    return { action: 'task.create', taskId: command.taskId, title: command.title, details: command.details as string | null, workspaceId: command.workspaceId as string | null,
      importance: command.importance, deadline: command.deadline as string | null, subtasks,
      ...(isPositiveInteger(command.expectedOrderVersion) ? { expectedOrderVersion: command.expectedOrderVersion } : {}) };
  }
  if (command.action === 'task.update') {
    if (!isUuid(command.taskId) || !isPositiveInteger(command.expectedVersion)) throw invalidResponse();
    const subtasks = command.subtasks === undefined ? undefined : normalizeUpdateSubtasks(command.subtasks);
    if (command.title !== undefined && typeof command.title !== 'string' || command.details !== undefined && !nullableStringGuard(command.details) ||
        command.status !== undefined && typeof command.status !== 'string' || command.importance !== undefined && !isImportance(command.importance) ||
        command.deadline !== undefined && !nullableDateGuard(command.deadline)) throw invalidResponse();
    return { action: 'task.update', taskId: command.taskId, expectedVersion: command.expectedVersion,
      ...(typeof command.title === 'string' ? { title: command.title } : {}), ...(command.details === undefined ? {} : { details: command.details as string | null }),
      ...(typeof command.status === 'string' ? { status: command.status } : {}), ...(isImportance(command.importance) ? { importance: command.importance } : {}),
      ...(command.deadline === undefined ? {} : { deadline: command.deadline as string | null }), ...(subtasks === undefined ? {} : { subtasks }) };
  }
  if (command.action === 'task.move') {
    if (!isUuid(command.taskId) || !isPositiveInteger(command.expectedVersion) || !nullableUuidGuard(command.workspaceId)) throw invalidResponse();
    return { action: 'task.move', taskId: command.taskId, expectedVersion: command.expectedVersion, workspaceId: command.workspaceId as string | null };
  }
  if (command.action === 'workspace.create') {
    if (!isUuid(command.workspaceId) || typeof command.name !== 'string' || !nullableStringGuard(command.objective)) throw invalidResponse();
    return { action: 'workspace.create', workspaceId: command.workspaceId, name: command.name, objective: command.objective as string | null };
  }
  if (command.action === 'workspace.update_objective') {
    if (!isUuid(command.workspaceId) || !isPositiveInteger(command.expectedVersion) || !nullableStringGuard(command.objective)) throw invalidResponse();
    return { action: 'workspace.update_objective', workspaceId: command.workspaceId, expectedVersion: command.expectedVersion, objective: command.objective as string | null };
  }
  throw invalidResponse();
}

function normalizeUpdateSubtasks(value: unknown): readonly { readonly id: string; readonly title: string; readonly completed: boolean }[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map((entry) => {
    const subtask = asRecord(entry);
    if (!subtask || !isUuid(subtask.id) || typeof subtask.title !== 'string' || typeof subtask.completed !== 'boolean') throw invalidResponse();
    return { id: subtask.id, title: subtask.title, completed: subtask.completed };
  });
}

function normalizeScope(value: unknown): HomeConversationScope {
  const scope = asRecord(value);
  if (scope?.kind === 'home') return { kind: 'home' };
  if (scope?.kind === 'workspace' && isUuid(scope.workspaceId)) return { kind: 'workspace', workspaceId: scope.workspaceId };
  throw invalidResponse();
}

function normalizeExecution(value: unknown): HomeProposalExecution {
  const execution = asRecord(value);
  if (!execution || !['completed', 'partial', 'unknown', 'cancelled'].includes(String(execution.state)) || !Array.isArray(execution.items)) throw invalidResponse();
  const items = execution.items.map((entry) => {
    const item = asRecord(entry);
    if (!item || !isUuid(item.itemId) || !isProposalItemState(item.state) || (item.receiptId !== null && !isUuid(item.receiptId)) || (item.resultCode !== null && typeof item.resultCode !== 'string')) throw invalidResponse();
    return { itemId: item.itemId, state: item.state, receiptId: item.receiptId as string | null, resultCode: item.resultCode as string | null };
  });
  return { state: execution.state as HomeProposalExecution['state'], items };
}

function conversationPath(conversationId: string): string {
  return `${PROPOSALS_PATH}/${encodeURIComponent(conversationId)}/proposals`;
}

function proposalItemPath(conversationId: string, proposalId: string, itemId: string): string {
  return `${conversationPath(conversationId)}/${encodeURIComponent(proposalId)}/items/${encodeURIComponent(itemId)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nullableString(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value;
  throw invalidResponse();
}

function nullableStringGuard(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function nullableUuidGuard(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

function nullableDateGuard(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value));
}

function isProposalState(value: unknown): value is HomeProposalState {
  return ['review_required', 'accepted', 'executing', 'partial', 'completed', 'cancelled', 'unknown'].includes(String(value));
}

function isProposalItemState(value: unknown): value is HomeProposalItemState {
  return ['ready', 'executing', 'saved', 'failed', 'conflicted', 'blocked', 'cancelled', 'unknown'].includes(String(value));
}

function isProposalAction(value: unknown): value is HomeProposalAction {
  return ['task.create', 'task.update', 'task.move', 'workspace.create', 'workspace.update_objective'].includes(String(value));
}

function isImportance(value: unknown): value is HomeProposalImportance {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'urgent';
}

function invalidResponse(): ApiClientError {
  return new ApiClientError(200, 'INVALID_RESPONSE', 'The local app returned an invalid Home proposal response.');
}
