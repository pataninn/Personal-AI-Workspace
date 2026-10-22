import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { projectReducer, type ProjectSnapshot, type ProjectState } from '@/entities/project';
import type { ProjectOverview } from '@/entities/project/api/project-overview-api';
import { sessionCleared, userSessionReducer } from '@/entities/user-session';
import { ApiClientError, registerSessionExpiryHandler } from '@/shared/api';
import type { AppShellOutletContext } from '@/widgets/app-shell';

const { createProjectMock, getProjectMock, listProjectsMock, getProjectOverviewMock } = vi.hoisted(() => ({
  createProjectMock: vi.fn(), getProjectMock: vi.fn(), listProjectsMock: vi.fn(), getProjectOverviewMock: vi.fn()
}));

vi.mock('@/entities/project/api/project-api', () => ({
  createProject: createProjectMock, getProject: getProjectMock, listProjects: listProjectsMock,
  updateProjectStatus: vi.fn()
}));
vi.mock('@/entities/project/api/project-overview-api', () => ({ getProjectOverview: getProjectOverviewMock }));
const ACTIVE_PROJECT: ProjectSnapshot = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Website', slug: 'website', workspaceMode: 'file_backed', capabilities: { planning: true, fileAccess: true }, status: 'active', version: 1,
  createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z'
};
const AUTHENTICATED_SESSION = {
  status: 'authenticated' as const, principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const }, csrfToken: 'csrf-value',
  expiresAt: '2026-09-13T00:00:00.000Z', errorCode: null
};
const PROJECT_STATE: ProjectState = { listStatus: 'success', projects: [ACTIVE_PROJECT], errorCode: null, detailById: {} };

function overview(projects: readonly ProjectSnapshot[] = [ACTIVE_PROJECT]): ProjectOverview {
  return { projects: projects.map((project) => ({ ...project, lastActivityAt: project.updatedAt })), tasks: [] };
}

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location-probe">{`${location.pathname}${location.search}`}</output>;
}

function renderDashboard(projectState: ProjectState = PROJECT_STATE, initialEntry = '/dashboard', shellContext: AppShellOutletContext | null = null) {
  const store = configureStore({ reducer: { project: projectReducer, userSession: userSessionReducer }, preloadedState: { project: projectState, userSession: AUTHENTICATED_SESSION } });
  render(<Provider store={store}><MemoryRouter initialEntries={[initialEntry]}><Routes>
    <Route element={<Outlet context={shellContext} />}>
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/projects/:projectId" element={<h1>Selected project</h1>} />
      <Route path="/projects/:projectId/tasks" element={<h1>Project tasks</h1>} />
      <Route path="/tasks" element={<h1>All tasks</h1>} />
      <Route path="/tasks/:taskId" element={<h1>Global task</h1>} />
    </Route>
  </Routes><LocationProbe /></MemoryRouter></Provider>);
  return store;
}

describe('DashboardPage chat and task Home', () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    createProjectMock.mockReset(); getProjectMock.mockReset(); listProjectsMock.mockReset(); getProjectOverviewMock.mockReset();
    getProjectOverviewMock.mockResolvedValue(overview());
    listProjectsMock.mockResolvedValue({ projects: [ACTIVE_PROJECT] });
  });

  it('keeps Home work surfaces primary and removes the inline conversation', async () => {
    renderDashboard();

    const hero = screen.getByRole('heading', { name: 'Home' }).closest('header');
    if (!hero) throw new Error('Home hero header should be rendered.');
    const upNextHeading = screen.getByRole('heading', { name: 'Up next' });

    expect(screen.queryByTestId('home-chat-widget')).not.toBeInTheDocument();
    expect(hero.nextElementSibling).toHaveAttribute('data-testid', 'home-overview-widget');
    expect(Boolean(hero.compareDocumentPosition(upNextHeading) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(screen.getByTestId('home-add-task-toggle')).toHaveAttribute('aria-controls', 'home-task-capture-form');
    expect(screen.getByTestId('home-view-all-tasks')).toHaveAttribute('href', '/tasks');
    expect(screen.queryByRole('heading', { name: 'Inbox' })).not.toBeInTheDocument();
  });

  it('shows the complete workspace list and opens a selected workspace', async () => {
    const projects = Array.from({ length: 6 }, (_, index) => ({ ...ACTIVE_PROJECT, id: `project-${index}`, name: `Project ${index + 1}` }));
    getProjectOverviewMock.mockResolvedValue(overview([]));
    renderDashboard({ ...PROJECT_STATE, projects });
    const user = userEvent.setup();
    const workspaces = await screen.findByTestId('home-workspace-list');
    const links = within(workspaces).getAllByRole('link');
    expect(links).toHaveLength(projects.length);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(projects.map((project) => `/projects/${project.id}`));
    await user.click(within(workspaces).getByRole('link', { name: /Project 5.*Files available/ }));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/projects/project-4');
  });

  it('shows six global task links with workspace, importance and deadline metadata', async () => {
    const tasks: ProjectOverview['tasks'] = Array.from({ length: 6 }, (_, index) => ({ id: `task-${index}`, projectId: ACTIVE_PROJECT.id, projectName: ACTIVE_PROJECT.name, title: `Next task ${index + 1}`, status: 'todo', importance: index === 0 ? 'urgent' : 'medium', deadline: index === 5 ? null : '2099-10-05', version: 1 }));
    getProjectOverviewMock.mockResolvedValue({ ...overview(), tasks });
    renderDashboard();
    const list = await screen.findByTestId('home-task-list');
    const links = within(list).getAllByRole('link');
    expect(links).toHaveLength(6);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(tasks.map((task) => `/tasks/${task.id}`));
    expect(within(list).getByText('Urgent')).toBeInTheDocument();
    expect(within(list).getByText('No deadline')).toBeInTheDocument();
    await userEvent.setup().click(links[0]);
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/tasks/task-0');
  });

  it('selects a project and shows an empty task state', async () => {
    renderDashboard();
    expect(await screen.findByTestId('home-tasks-empty')).toHaveTextContent('No open tasks');
    await userEvent.setup().click(screen.getByRole('link', { name: /Website.*Files available/ }));
    expect(screen.getByRole('heading', { name: 'Selected project' })).toBeInTheDocument();
  });

  it('creates a project, updates the store and navigates to it', async () => {
    const createdProject = { ...ACTIVE_PROJECT, id: 'created-project', name: 'Website App', slug: 'website-app' };
    createProjectMock.mockResolvedValue(createdProject);
    const store = renderDashboard();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('project-create-trigger')).toBeEnabled());
    await user.click(screen.getByTestId('project-create-trigger'));
    await user.type(screen.getByLabelText('Project name'), createdProject.name);
    expect(screen.getByLabelText('Workspace features')).toHaveValue('file_backed');
    expect(screen.getByTestId('project-workspace-mode-help')).toHaveTextContent('The app manages a private folder for files and file-based runs.');
    expect(screen.queryByLabelText(/root|folder/i)).not.toBeInTheDocument();
    await user.click(screen.getByTestId('project-create-submit'));
    await waitFor(() => expect(screen.getByTestId('location-probe')).toHaveTextContent('/projects/created-project'));
    expect(createProjectMock).toHaveBeenCalledWith({ name: createdProject.name, workspaceMode: 'file_backed' }, 'csrf-value');
    expect(store.getState().project.projects).toContainEqual(createdProject);
  });

  it('requires a project name and focuses the invalid field', async () => {
    renderDashboard();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('project-create-trigger')).toBeEnabled());
    await user.click(screen.getByTestId('project-create-trigger'));
    await user.click(screen.getByTestId('project-create-submit'));
    expect(screen.getByTestId('project-name-error')).toHaveTextContent('Enter a project name.');
    expect(screen.getByLabelText('Project name')).toHaveFocus();
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it('maps project-name conflicts without exposing internal details', async () => {
    createProjectMock.mockRejectedValue(new ApiClientError(409, 'PROJECT_NAME_CONFLICT', 'internal account detail'));
    renderDashboard();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('project-create-trigger')).toBeEnabled());
    await user.click(screen.getByTestId('project-create-trigger'));
    await user.type(screen.getByLabelText('Project name'), 'Existing project');
    await user.click(screen.getByTestId('project-create-submit'));
    expect(await screen.findByTestId('project-name-error')).toHaveTextContent('Choose a different project name.');
    expect(screen.queryByText('internal account detail')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toHaveFocus();
  });

  it('keeps the draft and offers retry or a planning-only choice when managed storage is unavailable', async () => {
    const planningProject: ProjectSnapshot = { ...ACTIVE_PROJECT, id: 'planning-project', name: 'Planning draft', workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false } };
    createProjectMock.mockRejectedValueOnce(new ApiClientError(503, 'WORKSPACE_STORAGE_UNAVAILABLE', 'C:\\private\\account root'));
    createProjectMock.mockResolvedValueOnce(planningProject);
    renderDashboard();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('project-create-trigger')).toBeEnabled());
    await user.click(screen.getByTestId('project-create-trigger'));
    await user.type(screen.getByLabelText('Project name'), planningProject.name);
    await user.click(screen.getByTestId('project-create-submit'));

    expect(await screen.findByTestId('workspace-storage-error')).toHaveTextContent('We could not create this project safely. Try again.');
    expect(screen.queryByText('C:\\private\\account root')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toHaveValue(planningProject.name);
    expect(screen.getByLabelText('Workspace features')).toHaveValue('file_backed');
    expect(screen.getByTestId('workspace-storage-retry-button')).toBeEnabled();

    await user.selectOptions(screen.getByLabelText('Workspace features'), 'planning');
    expect(screen.getByTestId('project-workspace-mode-help')).toHaveTextContent('Tasks, memory, and planning assistance remain available where enabled.');
    await user.click(screen.getByTestId('project-create-submit'));
    await waitFor(() => expect(screen.getByTestId('location-probe')).toHaveTextContent('/projects/planning-project'));
    expect(createProjectMock).toHaveBeenNthCalledWith(1, { name: planningProject.name, workspaceMode: 'file_backed' }, 'csrf-value');
    expect(createProjectMock).toHaveBeenNthCalledWith(2, { name: planningProject.name, workspaceMode: 'planning' }, 'csrf-value');
  });

  it('fails closed on workspace boundary errors and retries overview loading', async () => {
    getProjectOverviewMock.mockRejectedValue(new ApiClientError(503, 'WORKSPACE_BOUNDARY_UNAVAILABLE', 'absolute host detail'));
    renderDashboard();
    expect(await screen.findByTestId('workspace-boundary-error')).toHaveTextContent('Workspaces are temporarily unavailable');
    expect(screen.getByTestId('home-up-next-error')).toHaveTextContent('Up next is unavailable.');
    expect(screen.getByTestId(`home-workspace-link-${ACTIVE_PROJECT.id}`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all tasks' })).toHaveAttribute('href', '/tasks');
    expect(screen.getByTestId('project-create-trigger')).toBeDisabled();
    expect(screen.queryByTestId('project-empty-state')).not.toBeInTheDocument();
    expect(screen.queryByText('absolute host detail')).not.toBeInTheDocument();
    getProjectOverviewMock.mockResolvedValue(overview());
    await userEvent.setup().click(screen.getByTestId('workspace-boundary-retry-button'));
    expect(await screen.findByTestId('home-tasks-empty')).toHaveTextContent('No open tasks yet.');
    expect(screen.getByTestId(`home-workspace-link-${ACTIVE_PROJECT.id}`)).toBeInTheDocument();
    expect(getProjectOverviewMock).toHaveBeenCalledTimes(2);
  });

  it('shows a generic retryable overview error without internal details', async () => {
    getProjectOverviewMock.mockRejectedValue(new ApiClientError(503, 'INTERNAL_ERROR', 'internal detail'));
    renderDashboard();
    expect(await screen.findByTestId('home-up-next-error')).toHaveTextContent('Up next is unavailable.');
    expect(screen.getByTestId('home-up-next-retry')).toBeEnabled();
    expect(screen.getByTestId(`home-workspace-link-${ACTIVE_PROJECT.id}`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all tasks' })).toHaveAttribute('href', '/tasks');
    expect(screen.queryByText('internal detail')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-create-trigger')).toBeDisabled();
  });

  it('keeps the independent workspace summary visible when Up next fails', async () => {
    getProjectOverviewMock.mockRejectedValue(new ApiClientError(503, 'INTERNAL_ERROR', 'internal detail'));
    renderDashboard({ ...PROJECT_STATE, projects: [ACTIVE_PROJECT, { ...ACTIVE_PROJECT, id: 'archived-project', name: 'Archived notes', status: 'archived' }] });

    expect(await screen.findByTestId('home-up-next-error')).toHaveTextContent('Up next is unavailable.');
    expect(screen.getByTestId(`home-workspace-link-${ACTIVE_PROJECT.id}`)).toBeInTheDocument();
    expect(screen.getByTestId('home-workspace-link-archived-project')).toHaveTextContent('Archived');
    expect(screen.getByRole('link', { name: 'View all tasks' })).toHaveAttribute('href', '/tasks');
    expect(screen.queryByText('internal detail')).not.toBeInTheDocument();
  });

  it('registers the Home summary refresh callback used by confirmed assistant actions', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { count: 2 }, error: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const refreshHomeSummaries: { current: (() => void) | null } = { current: null };
    renderDashboard(PROJECT_STATE, '/dashboard', { registerHomeSummaryRefresh: (refresh) => { refreshHomeSummaries.current = refresh; } });
    await screen.findByRole('heading', { name: 'Up next' });
    await waitFor(() => expect(refreshHomeSummaries.current).toEqual(expect.any(Function)));
    expect(fetchMock).not.toHaveBeenCalled();
    getProjectOverviewMock.mockClear();
    listProjectsMock.mockClear();
    refreshHomeSummaries.current?.();

    await waitFor(() => expect(getProjectOverviewMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listProjectsMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the session when project list loading returns 401', async () => {
    listProjectsMock.mockRejectedValue(new ApiClientError(401, 'SESSION_UNAUTHENTICATED', 'expired'));
    const store = renderDashboard({ listStatus: 'idle', projects: [], errorCode: null, detailById: {} });
    const unregister = registerSessionExpiryHandler(() => store.dispatch(sessionCleared('SESSION_UNAUTHENTICATED')));
    await waitFor(() => expect(store.getState().userSession.status).toBe('unauthenticated'));
    unregister();
  });

  it('clears the session when project creation returns 401', async () => {
    createProjectMock.mockRejectedValue(new ApiClientError(401, 'SESSION_UNAUTHENTICATED', 'expired'));
    const store = renderDashboard();
    const unregister = registerSessionExpiryHandler(() => store.dispatch(sessionCleared('SESSION_UNAUTHENTICATED')));
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('project-create-trigger')).toBeEnabled());
    await user.click(screen.getByTestId('project-create-trigger'));
    await user.type(screen.getByLabelText('Project name'), 'Expired project');
    await user.click(screen.getByTestId('project-create-submit'));
    await waitFor(() => expect(store.getState().userSession.status).toBe('unauthenticated'));
    unregister();
  });
});
