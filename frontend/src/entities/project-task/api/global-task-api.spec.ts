import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/shared/api';
import { archiveGlobalTask, createInboxTask, getGlobalTask, getInboxTaskCount, getTaskActionReceipt, listGlobalTasks, moveGlobalTask, undoTaskAction, updateGlobalTask } from '@/entities/project-task/api/global-task-api';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const ACTION_ID = '33333333-3333-4333-8333-333333333333';
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

  it('sends a sparse edit patch with version and idempotency preconditions', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ item: inboxItem, receipt: { id: ACTION_ID, actionKind: 'task.update', undoStatus: 'available', outcome: {} }, replayed: false }));
    await expect(updateGlobalTask(TASK_ID, { title: 'Updated title' }, 4, 'csrf', 'stable-edit-key'))
      .resolves.toMatchObject({ item: inboxItem, replayed: false, receipt: { id: ACTION_ID, actionKind: 'task.update', undoStatus: 'available' } });
    const [path, request] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/v1/tasks/${TASK_ID}`);
    expect(request?.method).toBe('PATCH');
    expect(JSON.parse(String(request?.body))).toEqual({ title: 'Updated title' });
    expect(new Headers(request?.headers).get('If-Match')).toBe('"4"');
    expect(new Headers(request?.headers).get('Idempotency-Key')).toBe('stable-edit-key');
    expect(new Headers(request?.headers).get('X-CSRF-Token')).toBe('csrf');
  });

  it('moves to Inbox or a rootless workspace and archives with the same guarded request shape', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ item: inboxItem, receipt: { id: ACTION_ID, actionKind: 'task.move', undoStatus: 'available', outcome: {} }, replayed: true }));
    await expect(moveGlobalTask(TASK_ID, null, 4, 'csrf', 'move-key')).resolves.toMatchObject({ receipt: { actionKind: 'task.move' }, replayed: true });
    const [movePath, moveRequest] = fetchMock.mock.calls[0] ?? [];
    expect(movePath).toBe(`/api/v1/tasks/${TASK_ID}/move`);
    expect(JSON.parse(String(moveRequest?.body))).toEqual({ workspaceId: null });
    expect(new Headers(moveRequest?.headers).get('If-Match')).toBe('"4"');

    fetchMock.mockResolvedValueOnce(envelope({ item: inboxItem, receipt: { id: ACTION_ID, actionKind: 'task.archive', undoStatus: 'available', outcome: {} }, replayed: false }));
    await archiveGlobalTask(TASK_ID, 4, 'csrf', 'archive-key');
    const [archivePath, archiveRequest] = fetchMock.mock.calls[1] ?? [];
    expect(archivePath).toBe(`/api/v1/tasks/${TASK_ID}/archive`);
    expect(JSON.parse(String(archiveRequest?.body))).toEqual({});
    expect(new Headers(archiveRequest?.headers).get('Idempotency-Key')).toBe('archive-key');
  });

  it('verifies safe receipt metadata on reload and submits an idempotent undo', async () => {
    const safeReceipt = { id: ACTION_ID, actionKind: 'task.archive', targetKind: 'task', targetId: TASK_ID, postVersion: 5, undoStatus: 'available', undoActionId: null };
    fetchMock.mockResolvedValueOnce(envelope(safeReceipt));
    await expect(getTaskActionReceipt(ACTION_ID)).resolves.toEqual(safeReceipt);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/actions/${ACTION_ID}`);

    fetchMock.mockResolvedValueOnce(envelope({ originalAction: { ...safeReceipt, undoStatus: 'undone', undoActionId: ACTION_ID },
      undoReceipt: { ...safeReceipt, actionKind: 'undo', undoStatus: 'not_reversible' }, target: { kind: 'task', item: inboxItem }, replayed: false }));
    await expect(undoTaskAction(ACTION_ID, 'csrf', 'undo-key')).resolves.toMatchObject({ item: inboxItem, replayed: false, originalAction: { undoStatus: 'undone' } });
    const [undoPath, undoRequest] = fetchMock.mock.calls[1] ?? [];
    expect(undoPath).toBe(`/api/v1/actions/${ACTION_ID}/undo`);
    expect(JSON.parse(String(undoRequest?.body))).toEqual({});
    expect(new Headers(undoRequest?.headers).get('Idempotency-Key')).toBe('undo-key');
    expect(new Headers(undoRequest?.headers).get('X-CSRF-Token')).toBe('csrf');

    fetchMock.mockResolvedValueOnce(envelope({ ...safeReceipt, targetId: 'not-a-task-id' }));
    await expect(getTaskActionReceipt(ACTION_ID)).rejects.toBeInstanceOf(ApiClientError);
  });
});

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
