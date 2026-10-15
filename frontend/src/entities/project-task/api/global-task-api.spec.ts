import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/shared/api';
import { createInboxTask, getGlobalTask, getInboxTaskCount, listGlobalTasks } from '@/entities/project-task/api/global-task-api';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const task = {
  id: TASK_ID, projectId: null, title: 'Send the proposal', details: null, importance: 'medium', deadline: null, subtasks: [],
  status: 'todo', position: 0, version: 1,
  source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
  createdAt: '2026-10-16T08:00:00.000Z', updatedAt: '2026-10-16T08:00:00.000Z', completedAt: null, archivedAt: null
} as const;
const inboxItem = { task, collection: 'inbox', workspace: null } as const;
const workspaceItem = { task: { ...task, projectId: WORKSPACE_ID }, collection: 'workspace', workspace: { id: WORKSPACE_ID, name: 'Website', status: 'active' } } as const;

const fetchMock = vi.fn<typeof fetch>();

describe('global task API', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends the full stable filter and cursor set and validates Inbox and workspace item identity', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ items: [workspaceItem], nextCursor: 'cursor-2' }));
    await expect(listGlobalTasks({ workspaceId: WORKSPACE_ID, status: 'todo', importance: 'high', deadlineFrom: '2026-10-01', deadlineTo: '2026-10-31', q: 'proposal', includeArchived: true, limit: 10 }, 'cursor-1'))
      .resolves.toEqual({ items: [workspaceItem], nextCursor: 'cursor-2' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/tasks?workspaceId=${WORKSPACE_ID}&status=todo&importance=high&deadlineFrom=2026-10-01&deadlineTo=2026-10-31&q=proposal&includeArchived=true&limit=10&cursor=cursor-1`);

    fetchMock.mockResolvedValueOnce(envelope({ items: [{ ...inboxItem, task: { ...task, projectId: WORKSPACE_ID } }], nextCursor: null }));
    await expect(listGlobalTasks()).rejects.toBeInstanceOf(ApiClientError);
  });

  it('preserves explicit historical detail reads on the stable task URL', async () => {
    fetchMock.mockResolvedValueOnce(envelope(inboxItem));
    await expect(getGlobalTask(TASK_ID, true)).resolves.toEqual(inboxItem);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/tasks/${TASK_ID}?includeArchived=true`);
  });

  it('creates a default Inbox task with the same idempotency key and CSRF token', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ item: inboxItem, replayed: true, receipt: { id: 'receipt' } }));
    await expect(createInboxTask('  Send the proposal  ', 'csrf-token', 'intent-key')).resolves.toEqual({ item: inboxItem, replayed: true });
    const [path, request] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe('/api/v1/tasks');
    expect(JSON.parse(String(request?.body))).toEqual({ title: 'Send the proposal', details: null, workspaceId: null, importance: 'medium', deadline: null, subtasks: [] });
    expect(new Headers(request?.headers).get('Idempotency-Key')).toBe('intent-key');
    expect(new Headers(request?.headers).get('X-CSRF-Token')).toBe('csrf-token');
  });

  it('reads only a canonical non-negative Inbox count', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ count: 0 }));
    await expect(getInboxTaskCount()).resolves.toEqual({ count: 0 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/tasks/inbox/count');

    fetchMock.mockResolvedValueOnce(envelope({ count: -1 }));
    await expect(getInboxTaskCount()).rejects.toBeInstanceOf(ApiClientError);
  });
});

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
