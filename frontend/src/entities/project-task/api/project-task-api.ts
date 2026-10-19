import { ApiClientError, getJson, patchJson, postJson } from '@/shared/api';
import { readTaskImportance, readTaskDeadline, readTaskSubtasks, readSuggestedSubtasks } from '@/entities/project-task/api/task-metadata';
import type {
  ProjectTask,
  ProjectTaskDraft,
  ProjectTaskFilter,
  ProjectTaskList,
  ProjectTaskStatus,
  ProjectTaskSuggestion,
  ProjectTaskSuggestionDecision,
  ProjectTaskUpdateResult
} from '@/entities/project-task/model/types';

const PROJECTS_PATH = '/api/v1/projects';

export async function listProjectTasks(projectId: string, filter: ProjectTaskFilter = 'all'): Promise<ProjectTaskList> {
  const response = await getJson<unknown>(`${projectTasksPath(projectId)}?status=${filter}`);
  return normalizeProjectTaskList(response, projectId);
}

export async function createProjectTask(
  projectId: string,
  draft: ProjectTaskDraft,
  csrfToken: string,
  idempotencyKey: string
): Promise<ProjectTaskUpdateResult> {
  const body = draft.details === null ? { ...draft, details: undefined } : draft;
  const response = await postJson<unknown>(projectTasksPath(projectId), body, {
    'X-CSRF-Token': csrfToken,
    'Idempotency-Key': idempotencyKey
  });
  return normalizeTaskMutation(response, projectId);
}

export async function updateProjectTask(
  projectId: string,
  taskId: string,
  draft: ProjectTaskDraft | { readonly status: ProjectTaskStatus },
  expectedVersion: number,
  csrfToken: string
): Promise<ProjectTaskUpdateResult> {
  const response = await patchJson<unknown>(
    `${projectTasksPath(projectId)}/${encodeURIComponent(taskId)}`,
    draft,
    versionHeaders(expectedVersion, csrfToken)
  );
  return normalizeTaskMutation(response, projectId);
}

export async function reorderProjectTask(
  projectId: string,
  taskId: string,
  direction: 'up' | 'down',
  orderVersion: number,
  csrfToken: string
): Promise<ProjectTaskList> {
  const response = await patchJson<unknown>(
    `${PROJECTS_PATH}/${encodeURIComponent(projectId)}/task-order`,
    { taskId, direction },
    versionHeaders(orderVersion, csrfToken)
  );
  return normalizeProjectTaskList(response, projectId);
}

export async function listProjectTaskSuggestions(projectId: string, status: 'all' | 'pending' = 'pending'): Promise<readonly ProjectTaskSuggestion[]> {
  const response = await getJson<unknown>(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}/task-suggestions?status=${status}`);
  const suggestions = asRecord(response)?.taskSuggestions;
  if (!Array.isArray(suggestions)) {
    throw invalidResponse();
  }
  return suggestions.map((suggestion) => normalizeProjectTaskSuggestion(suggestion, projectId));
}

export async function listConversationProjectTaskSuggestions(projectId: string, conversationId: string): Promise<readonly ProjectTaskSuggestion[]> {
  const response = await getJson<unknown>(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}/task-suggestions?conversationId=${encodeURIComponent(conversationId)}&status=all`);
  const suggestions = asRecord(response)?.taskSuggestions;
  if (!Array.isArray(suggestions)) {
    throw invalidResponse();
  }
  return suggestions.map((value) => {
    const suggestion = normalizeProjectTaskSuggestion(value, projectId);
    if (suggestion.conversationId !== conversationId) {
      throw invalidResponse();
    }
    return suggestion;
  });
}

export async function decideProjectTaskSuggestion(
  projectId: string,
  suggestion: ProjectTaskSuggestion,
  decision: 'accepted' | 'dismissed',
  csrfToken: string,
  draft?: ProjectTaskDraft
): Promise<ProjectTaskSuggestionDecision> {
  const body = decision === 'dismissed'
    ? { status: decision }
    : { status: decision, ...(draft ?? {}) };
  const response = await patchJson<unknown>(
    `${PROJECTS_PATH}/${encodeURIComponent(projectId)}/task-suggestions/${encodeURIComponent(suggestion.id)}`,
    body,
    versionHeaders(suggestion.version, csrfToken)
  );
  return normalizeSuggestionDecision(response, projectId, decision);
}

export function normalizeProjectTask(value: unknown, expectedProjectId?: string): ProjectTask {
  const record = asRecord(value);
  const task: ProjectTask = {
    id: readNonEmptyString(record?.id),
    projectId: readNullableString(record?.projectId),
    title: readNonEmptyString(record?.title),
    details: readNullableString(record?.details),
    importance: readTaskImportance(record?.importance),
    deadline: readTaskDeadline(record?.deadline),
    subtasks: readTaskSubtasks(record?.subtasks),
    status: readTaskStatus(record?.status),
    position: readNonNegativeInteger(record?.position),
    version: readPositiveInteger(record?.version),
    source: normalizeTaskSource(record?.source),
    createdAt: readNonEmptyString(record?.createdAt),
    updatedAt: readNonEmptyString(record?.updatedAt),
    completedAt: readNullableString(record?.completedAt)
  };
  if (expectedProjectId && task.projectId !== expectedProjectId) {
    throw invalidResponse();
  }
  return task;
}

export function normalizeProjectTaskSuggestion(value: unknown, expectedProjectId?: string): ProjectTaskSuggestion {
  const record = asRecord(value);
  const source = asRecord(record?.source);
  const suggestion: ProjectTaskSuggestion = {
    id: readNonEmptyString(record?.id),
    projectId: readNonEmptyString(record?.projectId),
    runId: readNonEmptyString(record?.runId),
    conversationId: readNonEmptyString(record?.conversationId),
    title: readNonEmptyString(record?.title),
    details: readNullableString(record?.details),
    subtasks: readSuggestedSubtasks(record?.subtasks),
    status: readSuggestionStatus(record?.status),
    version: readPositiveInteger(record?.version),
    taskId: readNullableString(record?.taskId),
    source: {
      kind: readSuggestionSourceKind(source?.kind),
      label: readNonEmptyString(source?.label)
    },
    createdAt: readNonEmptyString(record?.createdAt),
    resolvedAt: readNullableString(record?.resolvedAt)
  };
  if (expectedProjectId && suggestion.projectId !== expectedProjectId) {
    throw invalidResponse();
  }
  return suggestion;
}

function normalizeProjectTaskList(value: unknown, projectId: string): ProjectTaskList {
  const record = asRecord(value);
  if (!Array.isArray(record?.tasks)) {
    throw invalidResponse();
  }
  return {
    tasks: record.tasks.map((task) => normalizeProjectTask(task, projectId)),
    orderVersion: readPositiveInteger(record?.orderVersion)
  };
}

function normalizeTaskMutation(value: unknown, projectId: string): ProjectTaskUpdateResult {
  const record = asRecord(value);
  return {
    task: normalizeProjectTask(record?.task, projectId),
    orderVersion: readPositiveInteger(record?.orderVersion)
  };
}

function normalizeSuggestionDecision(
  value: unknown,
  projectId: string,
  decision: 'accepted' | 'dismissed'
): ProjectTaskSuggestionDecision {
  const record = asRecord(value);
  const taskSuggestion = normalizeProjectTaskSuggestion(record?.taskSuggestion, projectId);
  if (decision === 'dismissed') {
    return { taskSuggestion, task: null, orderVersion: null };
  }
  return {
    taskSuggestion,
    task: normalizeProjectTask(record?.task, projectId),
    orderVersion: readPositiveInteger(record?.orderVersion)
  };
}

function normalizeTaskSource(value: unknown): ProjectTask['source'] {
  const source = asRecord(value);
  const kind = source?.kind;
  const common = { label: readNonEmptyString(source?.label) };
  if (kind === 'user') {
    if (source?.suggestionId !== null || source?.runId !== null || source?.conversationId !== null || source?.acceptedAt !== null) {
      throw invalidResponse();
    }
    return { kind, ...common, suggestionId: null, runId: null, conversationId: null, acceptedAt: null };
  }
  if (kind === 'assistant_suggestion') {
    return {
      kind,
      ...common,
      suggestionId: readNonEmptyString(source?.suggestionId),
      runId: readNonEmptyString(source?.runId),
      conversationId: readNonEmptyString(source?.conversationId),
      acceptedAt: readNonEmptyString(source?.acceptedAt)
    };
  }
  throw invalidResponse();
}

function readTaskStatus(value: unknown): ProjectTaskStatus {
  if (value === 'todo' || value === 'in_progress' || value === 'blocked' || value === 'done') {
    return value;
  }
  throw invalidResponse();
}

function readSuggestionStatus(value: unknown): ProjectTaskSuggestion['status'] {
  if (value === 'pending' || value === 'accepted' || value === 'dismissed') {
    return value;
  }
  throw invalidResponse();
}

function readSuggestionSourceKind(value: unknown): 'assistant' {
  if (value === 'assistant') {
    return value;
  }
  throw invalidResponse();
}

function readPositiveInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  throw invalidResponse();
}

function readNonNegativeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw invalidResponse();
}

function readNonEmptyString(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw invalidResponse();
}

function readNullableString(value: unknown): string | null {
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw invalidResponse();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function projectTasksPath(projectId: string): string {
  return `${PROJECTS_PATH}/${encodeURIComponent(projectId)}/tasks`;
}

function versionHeaders(version: number, csrfToken: string): HeadersInit {
  return { 'X-CSRF-Token': csrfToken, 'If-Match': `"${version}"` };
}

function invalidResponse(): ApiClientError {
  return new ApiClientError(200, 'INVALID_RESPONSE', 'The local app returned an invalid response.');
}
