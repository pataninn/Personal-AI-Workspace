import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { projectReducer, type ProjectSnapshot, type ProjectState } from '@/entities/project';
import type { ProjectOverview } from '@/entities/project/api/project-overview-api';
import { sessionCleared, userSessionReducer } from '@/entities/user-session';
import { ApiClientError, registerSessionExpiryHandler } from '@/shared/api';

const { createProjectMock, getProjectMock, listProjectsMock, removeProjectMock, getProjectOverviewMock } = vi.hoisted(() => ({
  createProjectMock: vi.fn(), getProjectMock: vi.fn(), listProjectsMock: vi.fn(), removeProjectMock: vi.fn(), getProjectOverviewMock: vi.fn()
}));

vi.mock('@/entities/project/api/project-api', () => ({
  createProject: createProjectMock, getProject: getProjectMock, listProjects: listProjectsMock,
  removeProject: removeProjectMock, updateProjectStatus: vi.fn()
}));
vi.mock('@/entities/project/api/project-overview-api', () => ({ getProjectOverview: getProjectOverviewMock }));

const ACTIVE_PROJECT: ProjectSnapshot = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Website', slug: 'website', relativeRoot: 'apps/website', status: 'active', version: 1,
  createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z'
};
const AUTHENTICATED_SESSION = {
  status: 'authenticated' as const, principal: { id: 'user-1', displayName: 'Local user' }, csrfToken: 'csrf-value',
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
  </Routes><LocationProbe /></MemoryRouter></Provider>);
  return store;
}

describe('DashboardPage chat and task Home', () => {
  beforeEach(() => {
    createProjectMock.mockReset(); getProjectMock.mockReset(); listProjectsMock.mockReset(); removeProjectMock.mockReset(); getProjectOverviewMock.mockReset();
    getProjectOverviewMock.mockResolvedValue(overview());
    listProjectsMock.mockResolvedValue({ projects: [ACTIVE_PROJECT] });
  });

  it('shows four activity-ranked projects and expands the remaining projects on Home', async () => {
    const projects = Array.from({ length: 6 }, (_, index) => ({ ...ACTIVE_PROJECT, id: `project-${index}`, name: `Project ${index + 1}`, relativeRoot: `projects/${index + 1}` }));
    getProjectOverviewMock.mockResolvedValue(overview(projects));
    renderDashboard();
    const user = userEvent.setup();
    const recent = await screen.findByRole('region', { name: 'Recent projects' });
    expect(within(recent).getAllByRole('link').map((link) => link.textContent)).toEqual(projects.slice(0, 4).map((project) => `${project.name}${project.relativeRoot}`));
    expect(screen.getByRole('link', { name: /Project 5/ })).not.toBeVisible();
    await user.click(screen.getByText('Other projects (2)'));
    expect(screen.getByTestId('home-more-projects')).toHaveAttribute('open');
    expect(screen.getByRole('link', { name: /Project 5/ })).toBeVisible();
    expect(screen.getByRole('link', { name: /Project 6/ })).toBeVisible();
    await user.click(screen.getByRole('link', { name: /Project 5/ }));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/projects/project-4');
  });

  it('shows six combined task links with importance and deadline metadata', async () => {
    const tasks: ProjectOverview['tasks'] = Array.from({ length: 6 }, (_, index) => ({ id: `task-${index}`, projectId: ACTIVE_PROJECT.id, projectName: ACTIVE_PROJECT.name, title: `Next task ${index + 1}`, status: 'todo', importance: index === 0 ? 'urgent' : 'medium', deadline: index === 5 ? null : '2099-10-05', version: 1 }));
    getProjectOverviewMock.mockResolvedValue({ ...overview(), tasks });
    renderDashboard();
    const list = await screen.findByTestId('home-task-list');
    const links = within(list).getAllByRole('link');
    expect(links).toHaveLength(6);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(tasks.map((task) => `/projects/${task.projectId}/tasks?task=${task.id}`));
    expect(within(list).getByText('Urgent')).toBeInTheDocument();
    expect(within(list).getByText('No deadline')).toBeInTheDocument();
    await userEvent.setup().click(links[0]);
    expect(screen.getByTestId('location-probe')).toHaveTextContent(`/projects/${ACTIVE_PROJECT.id}/tasks?task=task-0`);
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
    await user.type(screen.getByLabelText('Folder inside your workspace'), createdProject.relativeRoot);
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
    const rootInput = screen.getByLabelText('Folder inside your workspace');
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
    await user.type(screen.getByLabelText('Folder inside your workspace'), 'apps/website-child');
    await user.click(screen.getByTestId('project-create-submit'));
    expect(await screen.findByTestId('project-relative-root-error')).toHaveTextContent('already used by another active project');
    expect(screen.queryByText('internal overlap detail')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Folder inside your workspace')).toHaveFocus();
  });

  it('removes a project only after confirmation and explicitly keeps its files', async () => {
    removeProjectMock.mockResolvedValue(undefined);
    const store = renderDashboard();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove Website' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Website?' });
    expect(within(dialog).getByText(/project folder and its files stay on your computer/)).toBeInTheDocument();
    await user.click(screen.getByTestId('project-remove-cancel'));
    expect(removeProjectMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Remove Website' }));
    getProjectOverviewMock.mockResolvedValue(overview([])); listProjectsMock.mockResolvedValue({ projects: [] });
    await user.click(screen.getByTestId('project-remove-confirm'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(removeProjectMock).toHaveBeenCalledWith(ACTIVE_PROJECT.id, ACTIVE_PROJECT.version, 'csrf-value');
    expect(await screen.findByTestId('project-empty-state')).toBeInTheDocument();
    expect(store.getState().project.projects).toEqual([]);
    expect(screen.queryByText('Archived projects')).not.toBeInTheDocument();
  });

  it('keeps a failed project removal open for retry', async () => {
    removeProjectMock.mockRejectedValue(new ApiClientError(409, 'PROJECT_BUSY', 'Stop the active run before removing this project.'));
    renderDashboard();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove Website' }));
    await user.click(screen.getByTestId('project-remove-confirm'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Stop the active run');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByTestId('project-remove-confirm')).toBeEnabled();
  });

  it('refreshes removed projects and explains pending backup cleanup without offering deletion again', async () => {
    removeProjectMock.mockRejectedValue(new ApiClientError(503, 'PROJECT_REMOVAL_CLEANUP_PENDING', 'Cleanup pending'));
    renderDashboard();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove Website' }));
    getProjectOverviewMock.mockResolvedValue(overview([]));
    listProjectsMock.mockResolvedValue({ projects: [] });
    await user.click(screen.getByTestId('project-remove-confirm'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Project removed' });
    expect(within(dialog).getByText(/Restart the app to retry cleanup/)).toBeInTheDocument();
    expect(screen.queryByTestId('project-remove-confirm')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(await screen.findByTestId('project-empty-state')).toBeInTheDocument();
  });

  it('fails closed on workspace boundary errors and retries overview loading', async () => {
    getProjectOverviewMock.mockRejectedValue(new ApiClientError(503, 'WORKSPACE_BOUNDARY_UNAVAILABLE', 'absolute host detail'));
    renderDashboard();
    expect(await screen.findByTestId('workspace-boundary-error')).toHaveTextContent('authoritative workspace is unavailable');
    expect(screen.getByTestId('project-create-trigger')).toBeDisabled();
    expect(screen.queryByTestId('project-empty-state')).not.toBeInTheDocument();
    expect(screen.queryByText('absolute host detail')).not.toBeInTheDocument();
    getProjectOverviewMock.mockResolvedValue(overview());
    await userEvent.setup().click(screen.getByTestId('workspace-boundary-retry-button'));
    expect(await screen.findByRole('region', { name: 'Recent projects' })).toBeInTheDocument();
    expect(getProjectOverviewMock).toHaveBeenCalledTimes(2);
  });

  it('shows a generic retryable overview error without internal details', async () => {
    getProjectOverviewMock.mockRejectedValue(new ApiClientError(503, 'INTERNAL_ERROR', 'internal detail'));
    renderDashboard();
    expect(await screen.findByTestId('project-list-error')).toHaveTextContent('Workspace could not be loaded');
    expect(screen.queryByText('internal detail')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-create-trigger')).toBeDisabled();
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
    await user.type(screen.getByLabelText('Folder inside your workspace'), 'expired');
    await user.click(screen.getByTestId('project-create-submit'));
    await waitFor(() => expect(store.getState().userSession.status).toBe('unauthenticated'));
    unregister();
  });
});
