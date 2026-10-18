import { ApiClientError, getJson, patchJson, postJson } from '@/shared/api';
import { normalizeProjectTask } from '@/entities/project-task/api/project-task-api';
import type { GlobalTaskItem, GlobalTaskQuery, GlobalTaskQueryPage, GlobalTaskWorkspace, InboxTaskCount, ProjectTaskDraft } from '@/entities/project-task/model/types';

const TASKS_PATH = '/api/v1/tasks';

export type GlobalTaskQueryOptions = Omit<GlobalTaskQuery, 'cursor'>;

export interface GlobalTaskCreateResult {
  readonly item: GlobalTaskItem;
  readonly replayed: boolean;
}

export interface GlobalTaskCreateDraft extends ProjectTaskDraft {
  readonly workspaceId: string | null;
}

export type GlobalTaskPatch = Partial<ProjectTaskDraft>;
export type TaskMutationKind = 'task.update' | 'task.move' | 'task.archive';
export type TaskUndoStatus = 'available' | 'not_reversible' | 'undone';

export interface TaskActionReceiptMetadata {
  readonly id: string;
  readonly actionKind: string;
  readonly targetKind: 'task' | 'workspace';
  readonly targetId: string;
  readonly postVersion: number | null;
  readonly undoStatus: TaskUndoStatus;
  readonly undoActionId: string | null;
}

export interface GlobalTaskMutationResult {
  readonly item: GlobalTaskItem;
  readonly receipt: { readonly id: string; readonly actionKind: TaskMutationKind; readonly undoStatus: Exclude<TaskUndoStatus, 'undone'> };
  readonly replayed: boolean;
}

export interface TaskUndoResult {
  readonly originalAction: TaskActionReceiptMetadata;
  readonly undoReceipt: TaskActionReceiptMetadata;
  readonly target: TaskUndoTarget;
  readonly replayed: boolean;
}

export type TaskUndoTarget =
  | { readonly kind: 'task'; readonly item: GlobalTaskItem }
  | { readonly kind: 'workspace'; readonly workspace: GlobalTaskWorkspace }
  | null;

export async function listGlobalTasks(query: GlobalTaskQueryOptions = {}, cursor?: string): Promise<GlobalTaskQueryPage> {
  const params = new URLSearchParams();
  if (query.workspaceId) params.set('workspaceId', query.workspaceId);
  if (query.inboxOnly) params.set('inboxOnly', 'true');
  if (query.status) params.set('status', query.status);
  if (query.importance) params.set('importance', query.importance);
  if (query.deadlineFrom) params.set('deadlineFrom', query.deadlineFrom);
  if (query.deadlineTo) params.set('deadlineTo', query.deadlineTo);
  if (query.q) params.set('q', query.q);
  if (query.includeArchived) params.set('includeArchived', 'true');
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (cursor) params.set('cursor', cursor);
  const serialized = params.toString();
  const suffix = serialized ? `?${serialized}` : '';
  const response = await getJson<unknown>(`${TASKS_PATH}${suffix}`);
  const record = asRecord(response);
  if (!Array.isArray(record?.items)) throw invalidResponse();
  return {
    items: record.items.map(normalizeGlobalTaskItem),
    nextCursor: readNullableString(record.nextCursor)
  };
}

export async function getGlobalTask(taskId: string, includeArchived = false): Promise<GlobalTaskItem> {
  const suffix = includeArchived ? '?includeArchived=true' : '';
  return normalizeGlobalTaskItem(await getJson<unknown>(`${TASKS_PATH}/${encodeURIComponent(taskId)}${suffix}`));
}

export async function getInboxTaskCount(): Promise<InboxTaskCount> {
  const response = asRecord(await getJson<unknown>(`${TASKS_PATH}/inbox/count`));
  return { count: readNonNegativeInteger(response?.count) };
}

export async function createGlobalTask(draft: GlobalTaskCreateDraft, csrfToken: string, idempotencyKey: string): Promise<GlobalTaskCreateResult> {
  const response = asRecord(await postJson<unknown>(TASKS_PATH, {
    title: draft.title.trim(), details: draft.details, workspaceId: draft.workspaceId,
    importance: draft.importance ?? 'medium', deadline: draft.deadline ?? null, subtasks: draft.subtasks ?? []
  }, { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }));
  if (typeof response?.replayed !== 'boolean') throw invalidResponse();
  return { item: normalizeGlobalTaskItem(response.item), replayed: response.replayed };
}

export function createInboxTask(title: string, csrfToken: string, idempotencyKey: string): Promise<GlobalTaskCreateResult> {
  return createGlobalTask({ title, details: null, workspaceId: null }, csrfToken, idempotencyKey);
}

export async function updateGlobalTask(taskId: string, patch: GlobalTaskPatch, expectedVersion: number, csrfToken: string, idempotencyKey: string): Promise<GlobalTaskMutationResult> {
  const response = asRecord(await patchJson<unknown>(`${TASKS_PATH}/${encodeURIComponent(taskId)}`, patch, mutationHeaders(expectedVersion, csrfToken, idempotencyKey)));
  return normalizeMutationResult(response, 'task.update');
}

export async function moveGlobalTask(taskId: string, workspaceId: string | null, expectedVersion: number, csrfToken: string, idempotencyKey: string): Promise<GlobalTaskMutationResult> {
  const response = asRecord(await postJson<unknown>(`${TASKS_PATH}/${encodeURIComponent(taskId)}/move`, { workspaceId }, mutationHeaders(expectedVersion, csrfToken, idempotencyKey)));
  return normalizeMutationResult(response, 'task.move');
}

export async function archiveGlobalTask(taskId: string, expectedVersion: number, csrfToken: string, idempotencyKey: string): Promise<GlobalTaskMutationResult> {
  const response = asRecord(await postJson<unknown>(`${TASKS_PATH}/${encodeURIComponent(taskId)}/archive`, {}, mutationHeaders(expectedVersion, csrfToken, idempotencyKey)));
  return normalizeMutationResult(response, 'task.archive');
}

export async function getTaskActionReceipt(actionId: string): Promise<TaskActionReceiptMetadata> {
  return normalizeActionReceipt(await getJson<unknown>(`/api/v1/actions/${encodeURIComponent(actionId)}`));
}

export async function undoTaskAction(actionId: string, csrfToken: string, idempotencyKey: string): Promise<TaskUndoResult> {
  const response = asRecord(await postJson<unknown>(`/api/v1/actions/${encodeURIComponent(actionId)}/undo`, {}, {
    'X-CSRF-Token': csrfToken,
    'Idempotency-Key': idempotencyKey
  }));
  const originalAction = normalizeActionReceipt(response?.originalAction);
  const undoReceipt = normalizeActionReceipt(response?.undoReceipt);
  if (typeof response?.replayed !== 'boolean') throw invalidResponse();
  return { originalAction, undoReceipt, target: normalizeUndoTarget(response.target), replayed: response.replayed };
}

export function normalizeGlobalTaskItem(value: unknown): GlobalTaskItem {
  const record = asRecord(value);
  const task = normalizeProjectTask(record?.task);
  if (record?.collection === 'inbox' && task.projectId === null && record.workspace === null) {
    return { task, collection: 'inbox', workspace: null };
  }
  const workspace = asRecord(record?.workspace);
  if (record?.collection !== 'workspace' || task.projectId === null || typeof workspace?.id !== 'string' || workspace.id !== task.projectId ||
      typeof workspace.name !== 'string' || workspace.name.length === 0 ||
      (workspace.status !== 'active' && workspace.status !== 'archived')) {
    throw invalidResponse();
  }
  return { task, collection: 'workspace', workspace: { id: workspace.id, name: workspace.name, status: workspace.status } };
}

function readNonNegativeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw invalidResponse();
}

function normalizeMutationResult(value: Record<string, unknown> | null, actionKind: TaskMutationKind): GlobalTaskMutationResult {
  const receipt = asRecord(value?.receipt);
  if (typeof value?.replayed !== 'boolean' || receipt?.actionKind !== actionKind || !isUuid(receipt.id) ||
      (receipt.undoStatus !== 'available' && receipt.undoStatus !== 'not_reversible')) throw invalidResponse();
  return {
    item: normalizeGlobalTaskItem(value.item),
    receipt: { id: receipt.id, actionKind, undoStatus: receipt.undoStatus },
    replayed: value.replayed
  };
}

function normalizeActionReceipt(value: unknown): TaskActionReceiptMetadata {
  const record = asRecord(value);
  if (!record || !isUuid(record.id) || typeof record.actionKind !== 'string' ||
      (record.targetKind !== 'task' && record.targetKind !== 'workspace') || !isUuid(record.targetId) ||
      (record.postVersion !== null && !readPositiveInteger(record.postVersion)) ||
      (record.undoStatus !== 'available' && record.undoStatus !== 'not_reversible' && record.undoStatus !== 'undone') ||
      (record.undoActionId !== null && !isUuid(record.undoActionId))) throw invalidResponse();
  return {
    id: record.id,
    actionKind: record.actionKind,
    targetKind: record.targetKind,
    targetId: record.targetId,
    postVersion: record.postVersion as number | null,
    undoStatus: record.undoStatus,
    undoActionId: record.undoActionId as string | null
  };
}

function normalizeUndoTarget(value: unknown): TaskUndoTarget {
  if (value === null) return null;
  const target = asRecord(value);
  if (target?.kind === 'task') return { kind: 'task', item: normalizeGlobalTaskItem(target.item) };
  if (target?.kind === 'workspace') {
    const workspace = asRecord(target.workspace);
    if (!workspace || !isUuid(workspace.id) || typeof workspace.name !== 'string' || workspace.name.length === 0 ||
        (workspace.status !== 'active' && workspace.status !== 'archived')) throw invalidResponse();
    return {
      kind: 'workspace',
      workspace: { id: workspace.id, name: workspace.name, status: workspace.status }
    };
  }
  throw invalidResponse();
}

function mutationHeaders(expectedVersion: number, csrfToken: string, idempotencyKey: string): HeadersInit {
  return {
    'X-CSRF-Token': csrfToken,
    'If-Match': `"${expectedVersion}"`,
    'Idempotency-Key': idempotencyKey
  };
}

function readPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function readNullableString(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value;
  throw invalidResponse();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function invalidResponse(): ApiClientError {
  return new ApiClientError(200, 'INVALID_RESPONSE', 'The local app returned an invalid response.');
}
