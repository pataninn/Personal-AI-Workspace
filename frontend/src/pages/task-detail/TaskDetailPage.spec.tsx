import { configureStore } from '@reduxjs/toolkit';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projectReducer } from '@/entities/project';
import type { ProjectSnapshot } from '@/entities/project';
import type { GlobalTaskDeleteResult, GlobalTaskItem } from '@/entities/project-task';
import { userSessionReducer } from '@/entities/user-session';
import type { AppShellOutletContext } from '@/widgets/app-shell';
import { ApiClientError } from '@/shared/api';
import { TaskDetailPage } from '@/pages/task-detail/TaskDetailPage';

const mocks = vi.hoisted(() => ({
  getGlobalTask: vi.fn(), getInboxTaskCount: vi.fn(), getTaskActionReceipt: vi.fn(), updateGlobalTask: vi.fn(), moveGlobalTask: vi.fn(),
  deleteGlobalTask: vi.fn(), undoTaskAction: vi.fn(), listProjects: vi.fn()
}));
vi.mock('@/entities/project-task/api/global-task-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/project-task/api/global-task-api')>(),
  getGlobalTask: mocks.getGlobalTask, getInboxTaskCount: mocks.getInboxTaskCount, getTaskActionReceipt: mocks.getTaskActionReceipt,
  updateGlobalTask: mocks.updateGlobalTask, moveGlobalTask: mocks.moveGlobalTask, deleteGlobalTask: mocks.deleteGlobalTask, undoTaskAction: mocks.undoTaskAction
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
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', completedAt: null },
  collection: 'inbox', workspace: null
};
const savedReceipt = { id: ACTION_ID, actionKind: 'task.update', actorKind: 'manual', turnId: null, targetKind: 'task', targetId: TASK_ID, postVersion: 2, undoStatus: 'available', undoActionId: null } as const;
const projectListState = { listStatus: 'success' as const, projects: [WORKSPACE, PLANNING, archivedWorkspace], errorCode: null, detailById: {} };

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderTaskDetail(entry = `/tasks/${TASK_ID}`, shellContext: AppShellOutletContext | null = null, initialEntries: string[] = [entry]) {
  const store = configureStore({ reducer: { project: projectReducer, userSession: userSessionReducer }, preloadedState: { project: projectListState, userSession: SESSION } });
  const router = createMemoryRouter([{
    element: <Outlet context={shellContext} />,
    children: [
      { path: '/tasks/:taskId', element: <><TaskDetailPage /><LocationProbe /></> },
      { path: '/tasks', element: <><h1>All tasks</h1><LocationProbe /></> },
      { path: '/dashboard', element: <><h1>Dashboard</h1><LocationProbe /></> }
    ]
  }], { initialEntries });
  const view = render(<Provider store={store}><RouterProvider router={router} /></Provider>);
  return { ...view, router };
}

function mutationResult(item: GlobalTaskItem, actionKind: 'task.update' | 'task.move', undoStatus: 'available' | 'not_reversible' = 'available') {
  return { item, receipt: { id: ACTION_ID, actionKind, undoStatus }, replayed: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const deletedTask: GlobalTaskDeleteResult = {
  taskId: TASK_ID,
  orderVersion: 2,
  receipt: { id: ACTION_ID, actionKind: 'task.delete', undoStatus: 'not_reversible' },
  replayed: false
};

describe('TaskDetailPage', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getGlobalTask.mockResolvedValue(inboxItem);
    mocks.getInboxTaskCount.mockResolvedValue({ count: 1 });
    mocks.getTaskActionReceipt.mockResolvedValue(savedReceipt);
    mocks.listProjects.mockResolvedValue({ projects: [WORKSPACE, PLANNING, archivedWorkspace] });
  });

  afterEach(() => { globalThis.sessionStorage.clear(); });

  it('loads an immediately editable task with a normalized no-op Save and shows Inbox location', async () => {
    const user = userEvent.setup();
    renderTaskDetail();
    expect(await screen.findByRole('heading', { name: 'Send the proposal' })).toBeInTheDocument();
    expect(screen.getByText('Inbox', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Task title/)).toHaveValue('Send the proposal');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByTestId('task-detail-save')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Send the proposal' })).toHaveFocus();
    await user.clear(screen.getByLabelText(/Task title/));
    await user.type(screen.getByLabelText(/Task title/), '  Send the proposal  ');
    expect(screen.getByTestId('task-detail-save')).toBeDisabled();
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
    await user.clear(screen.getByLabelText(/Task title/));
    await user.type(screen.getByLabelText(/Task title/), 'Send the updated proposal');
    await user.click(screen.getByTestId('task-detail-save'));

    expect(await screen.findByTestId('task-action-receipt')).toHaveTextContent('Task changes saved');
    expect(screen.getByTestId('task-refresh-warning')).toHaveTextContent('some lists or counts may be stale');
    expect(screen.getByRole('heading', { name: 'Send the updated proposal' })).toBeInTheDocument();
    expect(mocks.updateGlobalTask).toHaveBeenCalledWith(TASK_ID, { title: 'Send the updated proposal' }, 1, 'csrf-token', expect.any(String));
    expect(mocks.getTaskActionReceipt).toHaveBeenCalledWith(ACTION_ID);
  });

  it('retries an uncertain save with the same idempotency key and clears dirty state on success', async () => {
    const user = userEvent.setup();
    const saved = { ...inboxItem, task: { ...inboxItem.task, title: 'Send the saved proposal', details: 'Preserved details', subtasks: [{ ...inboxItem.task.subtasks[0]!, title: 'Send it', completed: true }], version: 2 } };
    mocks.getGlobalTask.mockResolvedValueOnce(inboxItem).mockResolvedValue(saved);
    mocks.updateGlobalTask.mockRejectedValueOnce(new Error('Connection dropped')).mockResolvedValueOnce(mutationResult(saved, 'task.update'));
    renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await user.clear(screen.getByLabelText(/Task title/));
    await user.type(screen.getByLabelText(/Task title/), 'Send the saved proposal');
    await user.clear(screen.getByLabelText('Details (optional)'));
    await user.type(screen.getByLabelText('Details (optional)'), 'Preserved details');
    await user.click(screen.getByRole('checkbox', { name: 'Mark Check dates complete' }));
    await user.clear(screen.getByLabelText('Checklist item 1'));
    await user.type(screen.getByLabelText('Checklist item 1'), 'Send it');
    await user.click(screen.getByTestId('task-detail-save'));
    expect(await screen.findByTestId('task-save-error')).toHaveTextContent('outcome is uncertain');
    expect(screen.getByLabelText(/Task title/)).toHaveValue('Send the saved proposal');
    expect(screen.getByLabelText('Details (optional)')).toHaveValue('Preserved details');
    expect(screen.getByLabelText('Checklist item 1')).toHaveValue('Send it');
    expect(screen.getByRole('checkbox', { name: 'Mark Send it complete' })).toBeChecked();
    const firstKey = mocks.updateGlobalTask.mock.calls[0]?.[4];
    await user.click(screen.getByRole('button', { name: 'Retry save' }));
    expect(await screen.findByTestId('task-save-notice')).toHaveTextContent('Task saved.');
    expect(mocks.updateGlobalTask).toHaveBeenCalledTimes(2);
    expect(mocks.updateGlobalTask.mock.calls[1]?.[4]).toBe(firstKey);
    expect(screen.getByTestId('task-detail-save')).toBeDisabled();
  });

  it('blocks dirty route exit once and lets the user keep or discard the draft', async () => {
    const user = userEvent.setup();
    renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await user.clear(screen.getByLabelText(/Task title/));
    await user.type(screen.getByLabelText(/Task title/), 'Unsaved title');
    await user.click(screen.getByTestId('task-detail-back-to-tasks'));
    expect(await screen.findByTestId('task-dirty-exit-confirmation')).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${TASK_ID}`);
    await user.click(screen.getByTestId('task-dirty-exit-keep'));
    expect(screen.queryByTestId('task-dirty-exit-confirmation')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Task title/)).toHaveValue('Unsaved title');

    await user.click(screen.getByTestId('task-detail-back-to-tasks'));
    await user.click(screen.getByTestId('task-dirty-exit-discard'));
    expect(await screen.findByRole('heading', { name: 'All tasks' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks');
  });

  it('warns on hard exit only while draft is dirty and lets Cancel restore the saved fields', async () => {
    const user = userEvent.setup();
    renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    const pristine = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pristine);
    expect(pristine.defaultPrevented).toBe(false);

    await user.clear(screen.getByLabelText(/Task title/));
    await user.type(screen.getByLabelText(/Task title/), 'Unsaved title');
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    await user.click(screen.getByTestId('task-detail-cancel'));
    await user.click(screen.getByTestId('task-dirty-exit-discard'));
    expect(screen.getByLabelText(/Task title/)).toHaveValue('Send the proposal');
    expect(screen.getByTestId('task-detail-save')).toBeDisabled();
  });

  it('asks before sign-out and resolves the shell guard only after an explicit choice', async () => {
    const user = userEvent.setup();
    const requestExit = vi.fn<() => Promise<boolean>>();
    const shellContext: AppShellOutletContext = {
      registerHomeSummaryRefresh: vi.fn(),
      registerTaskEditorExitGuard: (guard) => { if (guard) requestExit.mockImplementation(guard); }
    };
    renderTaskDetail(`/tasks/${TASK_ID}`, shellContext);
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await waitFor(() => expect(requestExit.getMockImplementation()).toBeTypeOf('function'));
    await user.clear(screen.getByLabelText(/Task title/));
    await user.type(screen.getByLabelText(/Task title/), 'Keep private draft');

    const keepRequest = requestExit();
    expect(await screen.findByTestId('task-dirty-exit-confirmation')).toBeVisible();
    await user.click(screen.getByTestId('task-dirty-exit-keep'));
    expect(await keepRequest).toBe(false);
    expect(screen.getByLabelText(/Task title/)).toHaveValue('Keep private draft');

    const discardRequest = requestExit();
    await screen.findByTestId('task-dirty-exit-confirmation');
    await user.click(screen.getByTestId('task-dirty-exit-discard'));
    expect(await discardRequest).toBe(true);
    expect(screen.getByLabelText(/Task title/)).toHaveValue('Send the proposal');
  });

  it('keeps the user edit and rebases untouched fields after a stale-version conflict', async () => {
    const user = userEvent.setup();
    const latest = { ...inboxItem, task: { ...inboxItem.task, details: 'Remote detail update', version: 2 } };
    const saved = { ...latest, task: { ...latest.task, title: 'My title', version: 3 } };
    mocks.getGlobalTask.mockResolvedValueOnce(inboxItem).mockResolvedValueOnce(latest).mockResolvedValueOnce(saved);
    mocks.updateGlobalTask.mockRejectedValueOnce(new ApiClientError(409, 'PROJECT_TASK_VERSION_CONFLICT', 'Changed')).mockResolvedValueOnce(mutationResult(saved, 'task.update'));
    renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await user.clear(screen.getByLabelText(/Task title/));
    await user.type(screen.getByLabelText(/Task title/), 'My title');
    await user.click(screen.getByTestId('task-detail-save'));
    expect(await screen.findByTestId('project-task-version-conflict')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Your draft' })).toHaveTextContent('My title');
    expect(screen.getByRole('region', { name: 'Latest saved' })).toHaveTextContent('Remote detail update');
    await user.click(screen.getByTestId('project-task-conflict-keep-editing'));
    expect(screen.getByLabelText('Details (optional)')).toHaveValue('Remote detail update');
    await user.click(screen.getByTestId('task-detail-save'));

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

  it('confirms deletion and retries an uncertain outcome with the same idempotency key', async () => {
    const user = userEvent.setup();
    mocks.deleteGlobalTask.mockRejectedValueOnce(new Error('Connection dropped')).mockResolvedValueOnce({
      taskId: TASK_ID, orderVersion: 2, receipt: { id: ACTION_ID, actionKind: 'task.delete', undoStatus: 'not_reversible' }, replayed: true
    });
    renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await user.clear(screen.getByLabelText(/Task title/));
    await user.type(screen.getByLabelText(/Task title/), 'Unsaved title');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByTestId('task-delete-confirmation')).toHaveTextContent('will be deleted');
    expect(screen.getByTestId('task-delete-confirmation')).toHaveTextContent('Your unsaved edits will also be discarded.');
    await user.click(screen.getByTestId('task-delete-confirmation-cancel'));
    expect(mocks.deleteGlobalTask).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Task title/)).toHaveValue('Unsaved title');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByTestId('task-delete-confirmation-confirm'));
    expect(await screen.findByRole('alert')).toHaveTextContent('delete outcome is uncertain');
    const firstKey = mocks.deleteGlobalTask.mock.calls[0]?.[3];
    await user.click(screen.getByRole('button', { name: 'Retry delete' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/tasks$/u));
    expect(screen.queryByTestId('task-dirty-exit-confirmation')).not.toBeInTheDocument();
    expect(mocks.deleteGlobalTask).toHaveBeenCalledTimes(2);
    expect(mocks.deleteGlobalTask.mock.calls[0]).toEqual([TASK_ID, 1, 'csrf-token', firstKey]);
    expect(mocks.deleteGlobalTask.mock.calls[1]?.[3]).toBe(firstKey);
  });

  it('blocks Back, SPA navigation, hard exit, and sign-out until pending delete succeeds', async () => {
    const user = userEvent.setup();
    const deletion = deferred<GlobalTaskDeleteResult>();
    mocks.deleteGlobalTask.mockReturnValue(deletion.promise);
    const requestSignOut = vi.fn<() => Promise<boolean>>();
    const shellContext: AppShellOutletContext = {
      registerHomeSummaryRefresh: vi.fn(),
      registerTaskEditorExitGuard: (guard) => { if (guard) requestSignOut.mockImplementation(guard); }
    };
    const { router } = renderTaskDetail(`/tasks/${TASK_ID}`, shellContext, ['/tasks', `/tasks/${TASK_ID}`]);
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await waitFor(() => expect(requestSignOut.getMockImplementation()).toBeTypeOf('function'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByTestId('task-delete-confirmation-confirm'));

    expect(screen.getByTestId('task-delete-confirmation-confirm')).toHaveTextContent('Deleting…');
    expect(screen.getByTestId('task-delete-confirmation-confirm')).toBeDisabled();
    expect(mocks.deleteGlobalTask).toHaveBeenCalledTimes(1);

    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${TASK_ID}`));
    await act(async () => { await router.navigate('/tasks'); });
    expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${TASK_ID}`);
    expect(screen.queryByTestId('task-dirty-exit-confirmation')).not.toBeInTheDocument();
    expect(await requestSignOut()).toBe(false);

    const hardExit = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(hardExit);
    expect(hardExit.defaultPrevented).toBe(true);
    expect(mocks.deleteGlobalTask).toHaveBeenCalledTimes(1);

    await act(async () => { deletion.resolve(deletedTask); });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/tasks$/u));
    expect(screen.queryByTestId('task-dirty-exit-confirmation')).not.toBeInTheDocument();
    expect(mocks.deleteGlobalTask).toHaveBeenCalledTimes(1);
  });

  it('preserves the draft when a deferred delete fails', async () => {
    const user = userEvent.setup();
    const deletion = deferred<GlobalTaskDeleteResult>();
    mocks.deleteGlobalTask.mockReturnValue(deletion.promise);
    renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await user.clear(screen.getByLabelText(/Task title/));
    await user.type(screen.getByLabelText(/Task title/), 'Draft survives delete failure');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByTestId('task-delete-confirmation-confirm'));

    await act(async () => { deletion.reject(new Error('Connection dropped')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('delete outcome is uncertain');
    expect(screen.getByLabelText(/Task title/)).toHaveValue('Draft survives delete failure');
    expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${TASK_ID}`);
    expect(screen.getByTestId('task-delete-confirmation-confirm')).toHaveTextContent('Retry delete');
    expect(mocks.deleteGlobalTask).toHaveBeenCalledTimes(1);
  });

  it('does not let a late delete response override a route after the detail page is gone', async () => {
    const user = userEvent.setup();
    const deletion = deferred<GlobalTaskDeleteResult>();
    mocks.deleteGlobalTask.mockReturnValue(deletion.promise);
    const { router, unmount } = renderTaskDetail();
    await screen.findByRole('heading', { name: 'Send the proposal' });
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByTestId('task-delete-confirmation-confirm'));
    expect(mocks.deleteGlobalTask).toHaveBeenCalledTimes(1);

    unmount();
    await router.navigate('/dashboard');
    expect(router.state.location.pathname).toBe('/dashboard');
    await act(async () => { deletion.resolve(deletedTask); });
    expect(router.state.location.pathname).toBe('/dashboard');
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

  it('shows a historical archive receipt as non-reversible after reload', async () => {
    globalThis.sessionStorage.setItem(`personal-ai:task-action-receipt:owner-1:${TASK_ID}`, ACTION_ID);
    mocks.getTaskActionReceipt.mockResolvedValue({ ...savedReceipt, actionKind: 'task.archive', undoStatus: 'not_reversible', postVersion: 2 });
    renderTaskDetail();
    await screen.findByTestId('task-action-receipt');

    expect(screen.getByTestId('task-action-receipt')).toHaveTextContent('cannot be undone');
    expect(screen.queryByTestId('task-undo')).not.toBeInTheDocument();
    expect(mocks.undoTaskAction).not.toHaveBeenCalled();
  });
});
