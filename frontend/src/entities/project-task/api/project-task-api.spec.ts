import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/shared/api';
import {
  createProjectTask,
  decideProjectTaskSuggestion,
  listProjectTaskSuggestions,
  listProjectTasks,
  reorderProjectTask,
  updateProjectTask
} from '@/entities/project-task/api/project-task-api';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const SUGGESTION_ID = '33333333-3333-4333-8333-333333333333';
const task = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: 'Update setup notes',
  details: null,
  importance: 'medium',
  deadline: null,
  subtasks: [],
  status: 'todo',
  position: 0,
  version: 1,
  source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
  completedAt: null,
} as const;
const suggestion = {
  id: SUGGESTION_ID,
  projectId: PROJECT_ID,
  runId: '44444444-4444-4444-8444-444444444444',
  conversationId: '55555555-5555-4555-8555-555555555555',
  title: 'Review the setup guide',
  details: 'Check local startup instructions.',
  subtasks: [],
  status: 'pending',
  version: 1,
  taskId: null,
  source: { kind: 'assistant', label: 'Suggested by the assistant' },
  createdAt: '2026-09-26T00:00:00.000Z',
  resolvedAt: null
} as const;

const fetchMock = vi.fn<typeof fetch>();

describe('project task API', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the requested filter and validates project scope and order version', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ tasks: [task], orderVersion: 3 }));

    await expect(listProjectTasks(PROJECT_ID, 'all')).resolves.toEqual({ tasks: [task], orderVersion: 3 });
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/projects/${PROJECT_ID}/tasks?status=all`, expect.objectContaining({ method: 'GET' }));

    fetchMock.mockResolvedValueOnce(envelope({ tasks: [{ ...task, projectId: 'other-project' }], orderVersion: 3 }));
    await expect(listProjectTasks(PROJECT_ID)).rejects.toBeInstanceOf(ApiClientError);
  });

  it('creates with CSRF and an idempotency key without sending server-owned fields', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ task, orderVersion: 2 }));

    await expect(createProjectTask(PROJECT_ID, { title: task.title, details: null }, 'csrf', 'intent-key'))
      .resolves.toEqual({ task, orderVersion: 2 });
    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(requestInit?.body))).toEqual({ title: task.title });
    expect(new Headers(requestInit?.headers).get('X-CSRF-Token')).toBe('csrf');
    expect(new Headers(requestInit?.headers).get('Idempotency-Key')).toBe('intent-key');
  });

  it('uses quoted task and order versions for updates and adjacent moves', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ task, orderVersion: 4 }));
    await updateProjectTask(PROJECT_ID, TASK_ID, { status: 'done' }, 3, 'csrf');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('If-Match')).toBe('"3"');

    fetchMock.mockResolvedValueOnce(envelope({ tasks: [task], orderVersion: 5 }));
    await reorderProjectTask(PROJECT_ID, TASK_ID, 'down', 4, 'csrf');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/projects/${PROJECT_ID}/task-order`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ taskId: TASK_ID, direction: 'down' });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('If-Match')).toBe('"4"');
  });

  it('preserves task metadata and sends CSRF and an idempotency key when creating', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ task, orderVersion: 4 }));
    const draft = { title: task.title, details: null, importance: 'urgent' as const, deadline: '2026-10-05', subtasks: [{ title: 'Review', completed: false }] };
    await createProjectTask(PROJECT_ID, draft, 'csrf', 'intent');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ title: task.title, importance: 'urgent', deadline: '2026-10-05', subtasks: [{ title: 'Review', completed: false }] });
  });

  it('rejects malformed metadata and nested subtask responses', async () => {
    for (const invalid of [{ importance: 'unknown' }, { deadline: '2026-02-30' }, { subtasks: [{ id: 'item', title: 'Nested', completed: false, subtasks: [] }] }]) {
      fetchMock.mockResolvedValueOnce(envelope({ tasks: [{ ...task, ...invalid }], orderVersion: 1 }));
      await expect(listProjectTasks(PROJECT_ID)).rejects.toBeInstanceOf(ApiClientError);
    }
  });

  it('lists and explicitly accepts or dismisses versioned suggestions', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ taskSuggestions: [suggestion] }));
    await expect(listProjectTaskSuggestions(PROJECT_ID)).resolves.toEqual([suggestion]);

    const acceptedTask = {
      ...task,
      source: { kind: 'assistant_suggestion', label: 'Added from an assistant suggestion · accepted by you', suggestionId: SUGGESTION_ID, runId: suggestion.runId, conversationId: suggestion.conversationId, acceptedAt: suggestion.createdAt }
    };
    fetchMock.mockResolvedValueOnce(envelope({ task: acceptedTask, taskSuggestion: { ...suggestion, status: 'accepted', taskId: TASK_ID }, orderVersion: 2 }));
    await expect(decideProjectTaskSuggestion(PROJECT_ID, suggestion, 'accepted', 'csrf', { title: 'Edited title', details: null }))
      .resolves.toEqual({ task: acceptedTask, taskSuggestion: { ...suggestion, status: 'accepted', taskId: TASK_ID }, orderVersion: 2 });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ status: 'accepted', title: 'Edited title', details: null });

    fetchMock.mockResolvedValueOnce(envelope({ taskSuggestion: { ...suggestion, status: 'dismissed', resolvedAt: suggestion.createdAt } }));
    await expect(decideProjectTaskSuggestion(PROJECT_ID, suggestion, 'dismissed', 'csrf'))
      .resolves.toMatchObject({ task: null, orderVersion: null, taskSuggestion: { status: 'dismissed' } });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ status: 'dismissed' });
  });
});

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
