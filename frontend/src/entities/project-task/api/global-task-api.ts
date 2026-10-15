import { ApiClientError, getJson, postJson } from '@/shared/api';
import { normalizeProjectTask } from '@/entities/project-task/api/project-task-api';
import type { GlobalTaskItem, GlobalTaskQuery, GlobalTaskQueryPage, InboxTaskCount } from '@/entities/project-task/model/types';

const TASKS_PATH = '/api/v1/tasks';

export type GlobalTaskQueryOptions = Omit<GlobalTaskQuery, 'cursor'>;

export interface GlobalTaskCreateResult {
  readonly item: GlobalTaskItem;
  readonly replayed: boolean;
}

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

export async function createInboxTask(title: string, csrfToken: string, idempotencyKey: string): Promise<GlobalTaskCreateResult> {
  const response = asRecord(await postJson<unknown>(TASKS_PATH, {
    title: title.trim(), details: null, workspaceId: null, importance: 'medium', deadline: null, subtasks: []
  }, { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }));
  if (typeof response?.replayed !== 'boolean') throw invalidResponse();
  return { item: normalizeGlobalTaskItem(response.item), replayed: response.replayed };
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
