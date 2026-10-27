import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { getGlobalTask } from '@/entities/project-task';

import type { ProjectSnapshot, HomeTaskSummary } from '@/entities/project';
import { HomeOverviewWidget, type HomeWorkspaceSummary } from '@/widgets/home-overview';

vi.mock('@/entities/project-task', async (importOriginal) => ({ ...await importOriginal<typeof import('@/entities/project-task')>(), getGlobalTask: vi.fn() }));

const ACTIVE_WORKSPACE: ProjectSnapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Studio refresh',
  slug: 'studio-refresh',
  workspaceMode: 'planning',
  capabilities: { planning: true, fileAccess: false },
  objective: 'Prepare the next launch.',
  status: 'active',
  version: 3,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z'
};

const ARCHIVED_WORKSPACE: ProjectSnapshot = {
  ...ACTIVE_WORKSPACE,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Retired site',
  slug: 'retired-site',
  workspaceMode: 'file_backed',
  capabilities: { planning: true, fileAccess: true },
  objective: null,
  status: 'archived',
  updatedAt: '2026-10-15T00:00:00.000Z'
};

const HOME_TASK: HomeTaskSummary = {
  id: 'task/alpha',
  projectId: ACTIVE_WORKSPACE.id,
  projectName: ACTIVE_WORKSPACE.name,
  title: 'Confirm release checklist',
  status: 'blocked',
  importance: 'urgent',
  deadline: '2026-10-25',
  version: 2
};

function renderOverview(options: {
  readonly tasks?: readonly HomeTaskSummary[];
  readonly taskStatus?: 'loading' | 'success' | 'error';
  readonly workspaces?: readonly HomeWorkspaceSummary[];
  readonly workspaceStatus?: 'loading' | 'success' | 'error';
  readonly csrfToken?: string | null;
  readonly onRetryTasks?: () => void;
  readonly onRetryWorkspaces?: () => void;
} = {}) {
  const props = {
    tasks: options.tasks ?? [],
    taskStatus: options.taskStatus ?? 'success',
    onRetryTasks: options.onRetryTasks ?? vi.fn(),
    workspaces: options.workspaces ?? [],
    workspaceStatus: options.workspaceStatus ?? 'success',
    csrfToken: options.csrfToken ?? 'csrf-token',
    onRetryWorkspaces: options.onRetryWorkspaces ?? vi.fn()
  };
  const result = render(<MemoryRouter><HomeOverviewWidget {...props} /></MemoryRouter>);
  return { ...result, props };
}

describe('HomeOverviewWidget', () => {
  it('renders task preview buttons, status and date-only metadata with active and archived workspaces', () => {
    renderOverview({
      tasks: [HOME_TASK],
      workspaces: [
        { project: ACTIVE_WORKSPACE, lastActivityAt: '2026-10-14T08:00:00.000Z' },
        { project: ARCHIVED_WORKSPACE, lastActivityAt: null }
      ]
    });

    const taskButton = screen.getByRole('button', { name: /Confirm release checklist/ });
    expect(taskButton).toHaveAttribute('aria-haspopup', 'dialog');
    expect(within(screen.getByTestId('home-up-next-section')).getByText(/Blocked/)).toBeInTheDocument();
    expect(within(screen.getByTestId('home-up-next-section')).getByText('Urgent')).toBeInTheDocument();

    const activeCard = screen.getByTestId(`home-workspace-link-${ACTIVE_WORKSPACE.id}`);
    expect(activeCard).toHaveAttribute('href', `/projects/${ACTIVE_WORKSPACE.id}`);
    expect(within(activeCard).getByText('Planning only')).toBeInTheDocument();
    expect(within(activeCard).getByText('Prepare the next launch.')).toBeInTheDocument();
    expect(within(activeCard).getByText(/Last active/)).toHaveAttribute('datetime', '2026-10-14T08:00:00.000Z');

    const archivedCard = screen.getByTestId(`home-workspace-link-${ARCHIVED_WORKSPACE.id}`);
    expect(within(archivedCard).getByText('Archived')).toBeInTheDocument();
    expect(within(archivedCard).getByText('Files available')).toBeInTheDocument();
    expect(within(archivedCard).getByText('Archived · read only')).toBeInTheDocument();
    expect(within(archivedCard).queryByText(/Last active|Updated/)).not.toBeInTheDocument();
    expect(screen.queryByText('01')).not.toBeInTheDocument();
  });

  it('opens full task details before editing and restores focus when closed', async () => {
    vi.mocked(getGlobalTask).mockResolvedValue({ collection: 'workspace', workspace: ACTIVE_WORKSPACE, task: {
      ...HOME_TASK, details: 'Confirm the release with the team.', subtasks: [{ id: 'step', title: 'Check release notes', completed: true }],
      position: 0, source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
      createdAt: '2026-10-01', updatedAt: '2026-10-01', completedAt: null
    } });
    renderOverview({ tasks: [HOME_TASK] });
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: /Confirm release checklist/ });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Confirm the release with the team.')).toBeInTheDocument();
    expect(within(dialog).getByText('Check release notes')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Edit task' })).toHaveAttribute('href', '/tasks/task%2Falpha');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('offers retry after a failed task detail request', async () => {
    vi.mocked(getGlobalTask).mockRejectedValue(new Error('Unavailable'));
    renderOverview({ tasks: [HOME_TASK] });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Confirm release checklist/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Task details could not be loaded.');
    expect(screen.queryByRole('link', { name: 'Edit task' })).not.toBeInTheDocument();
    vi.mocked(getGlobalTask).mockClear();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(getGlobalTask).toHaveBeenCalledWith(HOME_TASK.id, true);
  });

  it('retries Up next without replacing or retrying the workspace section', async () => {
    const onRetryTasks = vi.fn();
    const onRetryWorkspaces = vi.fn();
    renderOverview({
      taskStatus: 'error',
      workspaces: [{ project: ACTIVE_WORKSPACE, lastActivityAt: null }],
      onRetryTasks,
      onRetryWorkspaces
    });

    expect(screen.getByTestId(`home-workspace-link-${ACTIVE_WORKSPACE.id}`)).toBeInTheDocument();
    expect(screen.getByTestId('home-up-next-error')).toHaveTextContent('Up next is unavailable.');
    await userEvent.setup().click(screen.getByTestId('home-up-next-retry'));
    expect(onRetryTasks).toHaveBeenCalledOnce();
    expect(onRetryWorkspaces).not.toHaveBeenCalled();
  });

  it('keeps loaded tasks visible when workspaces fail and retries only that list', async () => {
    const onRetryTasks = vi.fn();
    const onRetryWorkspaces = vi.fn();
    renderOverview({
      tasks: [HOME_TASK],
      workspaces: [{ project: ARCHIVED_WORKSPACE, lastActivityAt: null }],
      workspaceStatus: 'error',
      onRetryTasks,
      onRetryWorkspaces
    });

    expect(screen.getByTestId(`home-up-next-task-${HOME_TASK.id}`)).toBeInTheDocument();
    expect(screen.getByTestId('home-workspaces-error')).toHaveTextContent('Showing the last loaded workspace summaries.');
    await userEvent.setup().click(screen.getByTestId('home-workspaces-retry'));
    expect(onRetryWorkspaces).toHaveBeenCalledOnce();
    expect(onRetryTasks).not.toHaveBeenCalled();
  });

  it('shows independent loading and empty copy for each summary', () => {
    const { rerender } = render(<MemoryRouter><HomeOverviewWidget tasks={[]} taskStatus="loading" onRetryTasks={vi.fn()} workspaces={[]} workspaceStatus="success" onRetryWorkspaces={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText('Loading Up next tasks')).toBeInTheDocument();
    expect(screen.getByTestId('home-workspaces-empty')).toHaveTextContent('No workspaces yet.');
    expect(screen.queryByTestId('home-tasks-empty')).not.toBeInTheDocument();

    rerender(<MemoryRouter><HomeOverviewWidget tasks={[]} taskStatus="success" onRetryTasks={vi.fn()} workspaces={[]} workspaceStatus="success" onRetryWorkspaces={vi.fn()} /></MemoryRouter>);
    expect(screen.getByTestId('home-tasks-empty')).toHaveTextContent('No open tasks yet.');
    expect(screen.getByTestId('home-workspaces-empty')).toBeInTheDocument();
  });

  it('keeps Add task and View all tasks available in an empty state and returns focus when capture closes', async () => {
    renderOverview();
    const addTask = screen.getByRole('button', { name: 'Add task' });
    expect(screen.getByRole('link', { name: 'View all tasks' })).toHaveAttribute('href', '/tasks');
    expect(addTask).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('home-task-capture-form')).not.toBeVisible();
    expect(screen.getByTestId('home-tasks-empty')).toHaveTextContent('No open tasks yet. Add a task to plan your next step.');

    const user = userEvent.setup();
    await user.click(addTask);
    expect(await screen.findByRole('textbox', { name: 'Task title' })).toHaveFocus();
    expect(screen.getByTestId('home-task-capture-form')).toBeVisible();
    expect(addTask).toHaveAttribute('aria-expanded', 'true');
    await user.click(addTask);
    expect(addTask).toHaveAttribute('aria-expanded', 'false');
    expect(addTask).toHaveFocus();
  });
});
