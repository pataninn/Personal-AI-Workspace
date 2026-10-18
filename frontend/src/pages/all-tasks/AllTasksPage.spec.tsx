import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectReducer } from '@/entities/project';
import type { ProjectSnapshot } from '@/entities/project';
import { userSessionReducer } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { AllTasksPage } from '@/pages/all-tasks/AllTasksPage';
import { TaskDetailPage } from '@/pages/task-detail/TaskDetailPage';

const { listGlobalTasksMock, getGlobalTaskMock } = vi.hoisted(() => ({ listGlobalTasksMock: vi.fn(), getGlobalTaskMock: vi.fn() }));
vi.mock('@/entities/project-task/api/global-task-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/project-task/api/global-task-api')>(), listGlobalTasks: listGlobalTasksMock, getGlobalTask: getGlobalTaskMock
}));

const WORKSPACE: ProjectSnapshot = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Website', slug: 'website', relativeRoot: null, status: 'active', version: 1,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
};
const SESSION = { status: 'authenticated' as const, principal: { id: 'user', displayName: 'Local user' }, csrfToken: 'csrf', expiresAt: '2099-01-01', errorCode: null };
const workspaceTask = {
  task: { id: 'task-1', projectId: WORKSPACE.id, title: 'Review proposal', details: null, importance: 'high', deadline: '2026-10-20', subtasks: [], status: 'todo', position: 0, version: 1,
    source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null }, createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', completedAt: null, archivedAt: null },
  collection: 'workspace', workspace: { id: WORKSPACE.id, name: WORKSPACE.name, status: 'active' }
} as const;
const anotherTask = { ...workspaceTask, task: { ...workspaceTask.task, id: 'task-2', title: 'Send summary' } };
const unassignedTask = { ...workspaceTask, task: { ...workspaceTask.task, id: 'task-unassigned', projectId: null, title: 'Sort receipts' }, collection: 'inbox', workspace: null } as const;
const archivedWorkspaceTask = {
  ...workspaceTask,
  workspace: { ...workspaceTask.workspace, status: 'archived' as const }
};

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderAllTasks(initialEntry = '/tasks') {
  const store = configureStore({ reducer: { project: projectReducer, userSession: userSessionReducer }, preloadedState: {
    project: { listStatus: 'success' as const, projects: [WORKSPACE], errorCode: null, detailById: {} }, userSession: SESSION
  } });
  render(<Provider store={store}><MemoryRouter initialEntries={[initialEntry]}><Routes>
    <Route path="/tasks" element={<AllTasksPage />} />
    <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
  </Routes><LocationProbe /></MemoryRouter></Provider>);
}

describe('AllTasksPage', () => {
  beforeEach(() => {
    listGlobalTasksMock.mockReset().mockResolvedValue({ items: [workspaceTask], nextCursor: null });
    getGlobalTaskMock.mockReset();
  });

  it('keeps applied filters in the URL and sends them to the global query', async () => {
    renderAllTasks();
    await screen.findByRole('link', { name: /Review proposal/ });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Status'), 'done');
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'proposal');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tasks?status=done&q=proposal'));
    await waitFor(() => expect(listGlobalTasksMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'done', q: 'proposal' })));
  });

  it('keeps unassigned tasks in All tasks and leaves Inbox available as a collection filter', async () => {
    listGlobalTasksMock.mockResolvedValue({ items: [workspaceTask, unassignedTask], nextCursor: null });
    renderAllTasks();
    const unassignedLink = await screen.findByRole('link', { name: /Sort receipts/ });

    expect(unassignedLink).toHaveTextContent('Unassigned');
    expect(screen.queryByRole('link', { name: 'Inbox' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Collection')).toHaveValue('all');

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Collection'), 'inbox');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tasks?inboxOnly=true'));
    await waitFor(() => expect(listGlobalTasksMock).toHaveBeenLastCalledWith({ inboxOnly: true }));
  });

  it('appends cursor results only when requested by Load more', async () => {
    listGlobalTasksMock.mockImplementation(async (_query: unknown, cursor?: string) => cursor
      ? { items: [anotherTask], nextCursor: null }
      : { items: [workspaceTask], nextCursor: 'next-page' });
    renderAllTasks();
    await screen.findByRole('link', { name: /Review proposal/ });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('global-task-load-more'));
    expect(await screen.findByRole('link', { name: /Send summary/ })).toBeInTheDocument();
    expect(listGlobalTasksMock).toHaveBeenLastCalledWith({}, 'next-page');
  });

  it('restarts from the first page when a saved cursor is rejected', async () => {
    listGlobalTasksMock.mockResolvedValueOnce({ items: [workspaceTask], nextCursor: 'stale-page' })
      .mockRejectedValueOnce(new ApiClientError(400, 'TASK_CURSOR_INVALID', 'Refresh'))
      .mockResolvedValueOnce({ items: [anotherTask], nextCursor: null });
    renderAllTasks();
    await screen.findByRole('link', { name: /Review proposal/ });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('global-task-load-more'));
    expect(await screen.findByTestId('global-task-refreshed')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Send summary/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Review proposal/ })).not.toBeInTheDocument();
  });

  it('preserves current results and exposes retry when stale-cursor refresh also fails', async () => {
    listGlobalTasksMock.mockResolvedValueOnce({ items: [workspaceTask], nextCursor: 'stale-page' })
      .mockRejectedValueOnce(new ApiClientError(400, 'TASK_CURSOR_INVALID', 'Refresh'))
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce({ items: [anotherTask], nextCursor: null });
    renderAllTasks();
    await screen.findByRole('link', { name: /Review proposal/ });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('global-task-load-more'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your current results are still available');
    expect(screen.getByRole('link', { name: /Review proposal/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry loading more' }));
    expect(await screen.findByRole('link', { name: /Send summary/ })).toBeInTheDocument();
  });

  it('keeps the historical-read flag when opening an active task in an archived workspace', async () => {
    listGlobalTasksMock.mockResolvedValue({ items: [archivedWorkspaceTask], nextCursor: null });
    getGlobalTaskMock.mockResolvedValue(archivedWorkspaceTask);
    renderAllTasks('/tasks?includeArchived=true');

    const taskLink = await screen.findByRole('link', { name: /Review proposal/ });
    expect(taskLink).toHaveAttribute('href', '/tasks/task-1?includeArchived=true');
    expect(listGlobalTasksMock).toHaveBeenCalledWith(expect.objectContaining({ includeArchived: true }));

    await userEvent.setup().click(taskLink);
    expect(await screen.findByRole('heading', { name: 'Review proposal' })).toBeInTheDocument();
    expect(screen.getByText('Website (archived workspace)', { selector: 'dd' })).toBeInTheDocument();
    expect(getGlobalTaskMock).toHaveBeenCalledWith('task-1', true);
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks/task-1?includeArchived=true');
  });
});
