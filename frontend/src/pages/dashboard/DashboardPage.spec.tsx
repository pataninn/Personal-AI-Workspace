import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { projectReducer, type ProjectSnapshot, type ProjectState } from '@/entities/project';
import type { ProjectOverview } from '@/entities/project/api/project-overview-api';
import { sessionCleared, userSessionReducer } from '@/entities/user-session';
import { ApiClientError, registerSessionExpiryHandler } from '@/shared/api';

const { createProjectMock, getProjectMock, listProjectsMock, getProjectOverviewMock } = vi.hoisted(() => ({
  createProjectMock: vi.fn(), getProjectMock: vi.fn(), listProjectsMock: vi.fn(), getProjectOverviewMock: vi.fn()
}));

vi.mock('@/entities/project/api/project-api', () => ({
  createProject: createProjectMock, getProject: getProjectMock, listProjects: listProjectsMock,
  updateProjectStatus: vi.fn()
}));
vi.mock('@/entities/project/api/project-overview-api', () => ({ getProjectOverview: getProjectOverviewMock }));
vi.mock('@/widgets/home-chat', () => ({
  HomeChatWidget: ({ scope, scopeLabel, onSummaryRefreshRequested }: { readonly scope: { readonly kind: string }; readonly scopeLabel: string; readonly onSummaryRefreshRequested?: () => void }) =>
    <section data-testid="home-chat-widget" data-scope={scope.kind} aria-label={scopeLabel}><button type="button" data-testid="simulate-confirmed-home-action" onClick={onSummaryRefreshRequested}>Simulate confirmed action</button></section>
}));

const ACTIVE_PROJECT: ProjectSnapshot = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Website', slug: 'website', relativeRoot: 'apps/website', status: 'active', version: 1,
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

function renderDashboard(projectState: ProjectState = PROJECT_STATE, initialEntry = '/dashboard') {
  const store = configureStore({ reducer: { project: projectReducer, userSession: userSessionReducer }, preloadedState: { project: projectState, userSession: AUTHENTICATED_SESSION } });
  render(<Provider store={store}><MemoryRouter initialEntries={[initialEntry]}><Routes>
    <Route path="/dashboard" element={<DashboardPage />} />
    <Route path="/projects/:projectId" element={<h1>Selected project</h1>} />
    <Route path="/projects/:projectId/tasks" element={<h1>Project tasks</h1>} />
    <Route path="/tasks" element={<h1>All tasks</h1>} />
    <Route path="/tasks/:taskId" element={<h1>Global task</h1>} />
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

  it('places the Home conversation after the hero and Up next after the conversation', async () => {
    renderDashboard();

    const chat = await screen.findByTestId('home-chat-widget');
    const hero = screen.getByRole('heading', { name: 'Home' }).closest('header');
    const upNextHeading = screen.getByRole('heading', { name: 'Up next' });

    expect(chat).toHaveAttribute('data-scope', 'home');
    expect(chat).toHaveAttribute('aria-label', 'Home');
    expect(hero?.nextElementSibling).toBe(chat);
    expect(Boolean(chat.compareDocumentPosition(upNextHeading) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(screen.getByTestId('home-add-task-toggle')).toHaveAttribute('aria-controls', 'home-task-capture-form');
    expect(screen.getByTestId('home-view-all-tasks')).toHaveAttribute('href', '/tasks');
    expect(screen.queryByRole('heading', { name: 'Inbox' })).not.toBeInTheDocument();
  });

  it('shows the complete workspace list and opens a selected workspace', async () => {
    const projects = Array.from({ length: 6 }, (_, index) => ({ ...ACTIVE_PROJECT, id: `project-${index}`, name: `Project ${index + 1}`, relativeRoot: `projects/${index + 1}` }));
    getProjectOverviewMock.mockResolvedValue(overview([]));
    renderDashboard({ ...PROJECT_STATE, projects });
    const user = userEvent.setup();
    const workspaces = await screen.findByTestId('home-workspace-list');
    const links = within(workspaces).getAllByRole('link');
    expect(links).toHaveLength(projects.length);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(projects.map((project) => `/projects/${project.id}`));
    await user.click(within(workspaces).getByRole('link', { name: /Project 5/ }));
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
    await userEvent.setup().click(screen.getByRole('link', { name: /Website.*apps\/website/ }));
    expect(screen.getByRole('heading', { name: 'Selected project' })).toBeInTheDocument();
  });

  it('creates a project, updates the store and navigates to it', async () => {
    const createdProject = { ...ACTIVE_PROJECT, id: 'created-project', name: 'Website App', slug: 'website-app', relativeRoot: 'apps/new-site' };
    createProjectMock.mockResolvedValue(createdProject);
    const store = renderDashboard();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('project-create-trigger')).toBeEnabled());
    await user.click(screen.getByTestId('project-create-trigger'));
    await user.type(screen.getByLabelText('Project name'), createdProject.name);
    await user.type(screen.getByLabelText('Root folder'), createdProject.relativeRoot);
    await user.click(screen.getByTestId('project-create-submit'));
    await waitFor(() => expect(screen.getByTestId('location-probe')).toHaveTextContent('/projects/created-project'));
    expect(createProjectMock).toHaveBeenCalledWith({ name: createdProject.name, relativeRoot: createdProject.relativeRoot }, 'csrf-value');
    expect(store.getState().project.projects).toContainEqual(createdProject);
  });

  it('rejects unsafe project roots locally and preserves the draft', async () => {
    renderDashboard();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('project-create-trigger')).toBeEnabled());
    await user.click(screen.getByTestId('project-create-trigger'));
    await user.type(screen.getByLabelText('Project name'), 'Unsafe project');
    const rootInput = screen.getByLabelText('Root folder');
    await user.type(rootInput, '../outside');
    await user.click(screen.getByTestId('project-create-submit'));
    expect(screen.getByTestId('project-relative-root-error')).toHaveTextContent('relative folder');
    expect(rootInput).toHaveValue('../outside'); expect(rootInput).toHaveFocus();
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it('maps overlap errors to the folder field without exposing internal details', async () => {
    createProjectMock.mockRejectedValue(new ApiClientError(409, 'PROJECT_ROOT_OVERLAP', 'internal root detail', [{ field: 'relativeRoot', message: 'internal overlap detail' }]));
    renderDashboard();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('project-create-trigger')).toBeEnabled());
    await user.click(screen.getByTestId('project-create-trigger'));
    await user.type(screen.getByLabelText('Project name'), 'Overlapping project');
    await user.type(screen.getByLabelText('Root folder'), 'apps/website-child');
    await user.click(screen.getByTestId('project-create-submit'));
    expect(await screen.findByTestId('project-relative-root-error')).toHaveTextContent('already used by another active project');
    expect(screen.queryByText('internal overlap detail')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Root folder')).toHaveFocus();
  });

  it('fails closed on workspace boundary errors and retries overview loading', async () => {
    getProjectOverviewMock.mockRejectedValue(new ApiClientError(503, 'WORKSPACE_BOUNDARY_UNAVAILABLE', 'absolute host detail'));
    renderDashboard();
    expect(await screen.findByTestId('workspace-boundary-error')).toHaveTextContent('authoritative workspace is unavailable');
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

  it('refreshes the bounded overview and complete workspace list after a confirmed chat action', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { count: 2 }, error: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderDashboard();
    await screen.findByTestId('home-chat-widget');
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByTestId('simulate-confirmed-home-action'));

    await waitFor(() => expect(getProjectOverviewMock).toHaveBeenCalledTimes(2));
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
    await user.type(screen.getByLabelText('Root folder'), 'expired');
    await user.click(screen.getByTestId('project-create-submit'));
    await waitFor(() => expect(store.getState().userSession.status).toBe('unauthenticated'));
    unregister();
  });
});
