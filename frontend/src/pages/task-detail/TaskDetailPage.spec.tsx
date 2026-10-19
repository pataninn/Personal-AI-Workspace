import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projectReducer } from '@/entities/project';
import type { ProjectSnapshot } from '@/entities/project';
import type { GlobalTaskItem } from '@/entities/project-task';
import { userSessionReducer } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { TaskDetailPage } from '@/pages/task-detail/TaskDetailPage';

const mocks = vi.hoisted(() => ({
  getGlobalTask: vi.fn(), getInboxTaskCount: vi.fn(), getTaskActionReceipt: vi.fn(), updateGlobalTask: vi.fn(), moveGlobalTask: vi.fn(),
  archiveGlobalTask: vi.fn(), undoTaskAction: vi.fn(), listProjects: vi.fn()
}));
vi.mock('@/entities/project-task/api/global-task-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/project-task/api/global-task-api')>(),
  getGlobalTask: mocks.getGlobalTask, getInboxTaskCount: mocks.getInboxTaskCount, getTaskActionReceipt: mocks.getTaskActionReceipt,
  updateGlobalTask: mocks.updateGlobalTask, moveGlobalTask: mocks.moveGlobalTask, archiveGlobalTask: mocks.archiveGlobalTask, undoTaskAction: mocks.undoTaskAction
}));
vi.mock('@/entities/project/api/project-api', async (importOriginal) => ({ ...await importOriginal<typeof import('@/entities/project/api/project-api')>(), listProjects: mocks.listProjects }));

const TASK_ID = '22222222-2222-4222-8222-222222222222';
const ACTION_ID = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const PLANNING_ID = '44444444-4444-4444-8444-444444444444';
const SESSION = { status: 'authenticated' as const, principal: { id: 'owner-1', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const }, csrfToken: 'csrf-token', expiresAt: '2099-01-01', errorCode: null };
const WORKSPACE: ProjectSnapshot = { id: WORKSPACE_ID, name: 'Website', slug: 'website', workspaceMode: 'file_backed', capabilities: { planning: true, fileAccess: true }, status: 'active', version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
const PLANNING: ProjectSnapshot = { id: PLANNING_ID, name: 'Planning', slug: 'planning', workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false }, status: 'active', version: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
const archivedWorkspace: ProjectSnapshot = { ...WORKSPACE, id: '55555555-5555-4555-8555-555555555555', name: 'Archived', status: 'archived' };
const inboxItem: GlobalTaskItem = {
  task: { id: TASK_ID, projectId: null, title: 'Send the proposal', details: 'Review the draft.', importance: 'medium', deadline: null,
    subtasks: [{ id: '66666666-6666-4666-8666-666666666666', title: 'Check dates', completed: false }], status: 'todo', position: 0, version: 1,
    source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', completedAt: null, archivedAt: null },
  collection: 'inbox', workspace: null
};
const savedReceipt = { id: ACTION_ID, actionKind: 'task.update', actorKind: 'manual', turnId: null, targetKind: 'task', targetId: TASK_ID, postVersion: 2, undoStatus: 'available', undoActionId: null } as const;
const projectListState = { listStatus: 'success' as const, projects: [WORKSPACE, PLANNING, archivedWorkspace], errorCode: null, detailById: {} };

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderTaskDetail(entry = `/tasks/${TASK_ID}`): void {
  const store = configureStore({ reducer: { project: projectReducer, userSession: userSessionReducer }, preloadedState: { project: projectListState, userSession: SESSION } });
  render(<Provider store={store}><MemoryRouter initialEntries={[entry]}><Routes><Route path="/tasks/:taskId" element={<TaskDetailPage />} /></Routes><LocationProbe /></MemoryRouter></Provider>);
}

function mutationResult(item: GlobalTaskItem, actionKind: 'task.update' | 'task.move' | 'task.archive', undoStatus: 'available' | 'not_reversible' = 'available') {
  return { item, receipt: { id: ACTION_ID, actionKind, undoStatus }, replayed: false };
}

describe('TaskDetailPage', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getGlobalTask.mockResolvedValue(inboxItem);
    mocks.getInboxTaskCount.mockResolvedValue({ count: 1 });
    mocks.getTaskActionReceipt.mockResolvedValue(savedReceipt);
    mocks.listProjects.mockResolvedValue({ projects: [WORKSPACE, PLANNING, archivedWorkspace] });
  });

  afterEach(() => { globalThis.sessionStorage.clear(); });

  it('loads a stable task, exposes the manual actions, and shows Inbox location', async () => {
    renderTaskDetail();
    expect(await screen.findByRole('heading', { name: 'Send the proposal' })).toBeInTheDocument();
    expect(screen.getByText('Inbox', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(mocks.getGlobalTask).toHaveBeenCalledWith(TASK_ID, false);
  });

  it('submits only changed fields, keeps a verified receipt, and warns separately when refresh fails', async () => {
    const user = userEvent.setup();
    const updated = { ...inboxItem, task: { ...inboxItem.task, title: 'Send the updated proposal', version: 2 } };
    mocks.getGlobalTask.mockResolvedValueOnce(inboxItem).mockResolvedValue(updated);
    mocks.updateGlobalTask.mockResolvedValue(mutationResult(updated, 'task.update'));
    mocks.getInboxTaskCount.mockRejectedValueOnce(new Error('Refresh unavailable'));
    renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Task title'));
    await user.type(screen.getByLabelText('Task title'), 'Send the updated proposal');
    await user.click(screen.getByTestId('project-task-editor-save'));

    expect(await screen.findByTestId('task-action-receipt')).toHaveTextContent('Task changes saved');
    expect(screen.getByTestId('task-refresh-warning')).toHaveTextContent('some lists or counts may be stale');
    expect(screen.getByRole('heading', { name: 'Send the updated proposal' })).toBeInTheDocument();
    expect(mocks.updateGlobalTask).toHaveBeenCalledWith(TASK_ID, { title: 'Send the updated proposal' }, 1, 'csrf-token', expect.any(String));
    expect(mocks.getTaskActionReceipt).toHaveBeenCalledWith(ACTION_ID);
  });

  it('keeps the user edit and rebases untouched fields after a stale-version conflict', async () => {
    const user = userEvent.setup();
    const latest = { ...inboxItem, task: { ...inboxItem.task, details: 'Remote detail update', version: 2 } };
    const saved = { ...latest, task: { ...latest.task, title: 'My title', version: 3 } };
    mocks.getGlobalTask.mockResolvedValueOnce(inboxItem).mockResolvedValueOnce(latest).mockResolvedValueOnce(saved);
    mocks.updateGlobalTask.mockRejectedValueOnce(new ApiClientError(409, 'PROJECT_TASK_VERSION_CONFLICT', 'Changed')).mockResolvedValueOnce(mutationResult(saved, 'task.update'));
    renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Task title'));
    await user.type(screen.getByLabelText('Task title'), 'My title');
    await user.click(screen.getByTestId('project-task-editor-save'));
    expect(await screen.findByTestId('project-task-version-conflict')).toBeVisible();
    await user.click(screen.getByTestId('project-task-conflict-keep-editing'));
    expect(screen.getByLabelText('Details (optional)')).toHaveValue('Remote detail update');
    await user.click(screen.getByTestId('project-task-editor-save'));

    await screen.findByTestId('task-action-receipt');
    expect(mocks.updateGlobalTask).toHaveBeenLastCalledWith(TASK_ID, { title: 'My title' }, 2, 'csrf-token', expect.any(String));
  });

  it('allows a rootless active workspace destination and keeps the stable task URL', async () => {
    const user = userEvent.setup();
    const moved: GlobalTaskItem = { task: { ...inboxItem.task, projectId: PLANNING_ID, version: 2 }, collection: 'workspace', workspace: { id: PLANNING_ID, name: 'Planning', status: 'active' } };
    mocks.moveGlobalTask.mockResolvedValue(mutationResult(moved, 'task.move'));
    mocks.getGlobalTask.mockResolvedValueOnce(inboxItem).mockResolvedValue(moved);
    renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(screen.getByRole('option', { name: 'Planning (planning only)' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Destination'), PLANNING_ID);
    await user.click(screen.getByRole('button', { name: 'Move to Planning' }));
    expect(await screen.findByText('Planning', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${TASK_ID}`);
    expect(mocks.moveGlobalTask).toHaveBeenCalledWith(TASK_ID, PLANNING_ID, 1, 'csrf-token', expect.any(String));
  });

  it('keeps the move destination and idempotency key when retrying after the dialog is closed', async () => {
    const user = userEvent.setup();
    const moved: GlobalTaskItem = { task: { ...inboxItem.task, projectId: PLANNING_ID, version: 2 }, collection: 'workspace', workspace: { id: PLANNING_ID, name: 'Planning', status: 'active' } };
    mocks.moveGlobalTask.mockRejectedValueOnce(new Error('Connection dropped')).mockResolvedValueOnce(mutationResult(moved, 'task.move'));
    renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await user.click(screen.getByRole('button', { name: 'Move' }));
    await user.selectOptions(screen.getByLabelText('Destination'), PLANNING_ID);
    await user.click(screen.getByTestId('task-move-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('move outcome is uncertain');
    const firstCall = mocks.moveGlobalTask.mock.calls[0];
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(screen.getByLabelText('Destination')).toHaveValue(PLANNING_ID);
    await user.click(screen.getByRole('button', { name: 'Retry move to Planning' }));
    await screen.findByTestId('task-action-receipt');
    expect(mocks.moveGlobalTask.mock.calls[1]?.[1]).toBe(firstCall?.[1]);
    expect(mocks.moveGlobalTask.mock.calls[1]?.[4]).toBe(firstCall?.[4]);
  });

  it('retries an uncertain archive with the same idempotency key and persists historical detail', async () => {
    const user = userEvent.setup();
    const archived = { ...inboxItem, task: { ...inboxItem.task, status: 'archived', version: 2, archivedAt: '2026-10-16T01:00:00.000Z' } } as const;
    mocks.archiveGlobalTask.mockRejectedValueOnce(new Error('Connection dropped')).mockResolvedValueOnce(mutationResult(archived, 'task.archive'));
    mocks.getGlobalTask.mockResolvedValueOnce(inboxItem).mockResolvedValue(archived);
    renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(await screen.findByTestId('task-archive-error')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry archive' }));
    expect(await screen.findByTestId('task-detail-archived')).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${TASK_ID}?includeArchived=true`);
    expect(mocks.archiveGlobalTask.mock.calls[1]?.[3]).toBe(mocks.archiveGlobalTask.mock.calls[0]?.[3]);
  });

  it('reloads a receipt only when its server-confirmed target matches this task', async () => {
    globalThis.sessionStorage.setItem(`personal-ai:task-action-receipt:owner-1:${TASK_ID}`, ACTION_ID);
    mocks.getTaskActionReceipt.mockResolvedValue({ ...savedReceipt, targetId: '77777777-7777-4777-8777-777777777777' });
    renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await waitFor(() => expect(mocks.getTaskActionReceipt).toHaveBeenCalledWith(ACTION_ID));
    expect(screen.queryByTestId('task-action-receipt')).not.toBeInTheDocument();
    expect(globalThis.sessionStorage.getItem(`personal-ai:task-action-receipt:owner-1:${TASK_ID}`)).toBeNull();
  });

  it('keeps archive undo available after a reload and removes historical mode after success', async () => {
    const user = userEvent.setup();
    const archived = { ...inboxItem, task: { ...inboxItem.task, status: 'archived', version: 2, archivedAt: '2026-10-16T01:00:00.000Z' } } as const;
    const active = { ...inboxItem, task: { ...inboxItem.task, version: 3 } };
    globalThis.sessionStorage.setItem(`personal-ai:task-action-receipt:owner-1:${TASK_ID}`, ACTION_ID);
    mocks.getGlobalTask.mockImplementation((_id, includeArchived) => Promise.resolve(includeArchived ? archived : active));
    mocks.getTaskActionReceipt.mockResolvedValueOnce({ ...savedReceipt, actionKind: 'task.archive', undoStatus: 'available', postVersion: 2 })
      .mockResolvedValue({ ...savedReceipt, actionKind: 'task.archive', undoStatus: 'undone', postVersion: 2 });
    mocks.undoTaskAction.mockResolvedValue({ originalAction: { ...savedReceipt, actionKind: 'task.archive', undoStatus: 'undone', postVersion: 2 }, undoReceipt: { ...savedReceipt, actionKind: 'undo', undoStatus: 'not_reversible' }, target: { kind: 'task', item: active }, replayed: false });
    renderTaskDetail(`/tasks/${TASK_ID}?includeArchived=true`);
    await screen.findByTestId('task-action-receipt');
    await user.click(screen.getByTestId('task-undo'));

    expect(await screen.findByTestId('task-undo-complete')).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${TASK_ID}`);
    expect(mocks.undoTaskAction).toHaveBeenCalledWith(ACTION_ID, 'csrf-token', expect.any(String));
  });
});
