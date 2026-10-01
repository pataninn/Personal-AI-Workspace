import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { projectReducer, type ProjectSnapshot, type ProjectState } from '@/entities/project';
import { sessionCleared, userSessionReducer } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { registerSessionExpiryHandler } from '@/shared/api';

const { createProjectMock, getProjectMock, listProjectsMock, updateProjectStatusMock } = vi.hoisted(() => ({
  createProjectMock: vi.fn(),
  getProjectMock: vi.fn(),
  listProjectsMock: vi.fn(),
  updateProjectStatusMock: vi.fn()
}));

vi.mock('@/entities/project/api/project-api', () => ({
  createProject: createProjectMock,
  getProject: getProjectMock,
  listProjects: listProjectsMock,
  updateProjectStatus: updateProjectStatusMock
}));

const ACTIVE_PROJECT: ProjectSnapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Website',
  slug: 'website',
  relativeRoot: 'apps/website',
  status: 'active',
  version: 1,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z'
};

const ARCHIVED_PROJECT: ProjectSnapshot = {
  ...ACTIVE_PROJECT,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Notes',
  slug: 'notes',
  relativeRoot: 'notes',
  status: 'archived',
  version: 2
};

const AUTHENTICATED_SESSION = {
  status: 'authenticated' as const,
  principal: { id: 'user-1', displayName: 'Local user' },
  csrfToken: 'csrf-value',
  expiresAt: '2026-09-13T00:00:00.000Z',
  errorCode: null
};

const PROJECT_STATE: ProjectState = {
  listStatus: 'success',
  projects: [ACTIVE_PROJECT],
  errorCode: null,
  detailById: {}
};

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location-probe">{`${location.pathname}${location.search}`}</output>;
}

function renderDashboard(projectState: ProjectState = PROJECT_STATE, initialEntry = '/dashboard') {
  const store = configureStore({
    reducer: { project: projectReducer, userSession: userSessionReducer },
    preloadedState: { project: projectState, userSession: AUTHENTICATED_SESSION }
  });

  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/projects/:projectId" element={<h1>Selected project</h1>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </Provider>
  );
  return store;
}

describe('DashboardPage project workspace flow', () => {
  beforeEach(() => {
    createProjectMock.mockReset();
    getProjectMock.mockReset();
    listProjectsMock.mockReset();
    updateProjectStatusMock.mockReset();
  });

  it('renders active and archived projects with relative roots and selects a project by link', async () => {
    renderDashboard({ ...PROJECT_STATE, projects: [ACTIVE_PROJECT, ARCHIVED_PROJECT] });
    const user = userEvent.setup();

    expect(screen.getByRole('heading', { name: 'Active projects' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Archived projects' })).toBeInTheDocument();
    expect(screen.getAllByText('Project root:')).toHaveLength(2);
    expect(screen.getByText('apps/website')).toBeInTheDocument();
    expect(screen.getByText('notes')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: /Website.*apps\/website.*Active/s }));

    expect(screen.getByTestId('location-probe')).toHaveTextContent(`/projects/${ACTIVE_PROJECT.id}`);
    expect(screen.getByRole('heading', { name: 'Selected project' })).toBeInTheDocument();
  });

  it('creates a project, updates the list, and navigates to the selected project', async () => {
    const createdProject: ProjectSnapshot = {
      ...ACTIVE_PROJECT,
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Website App',
      slug: 'website-app',
      relativeRoot: 'apps/new-site'
    };
    createProjectMock.mockResolvedValue(createdProject);
    const store = renderDashboard();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('project-create-trigger'));
    expect(screen.getByRole('dialog', { name: 'Create project' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Project name'), createdProject.name);
    await user.type(screen.getByLabelText('Folder inside your workspace'), createdProject.relativeRoot);
    await user.click(screen.getByTestId('project-create-submit'));

    await waitFor(() => expect(screen.getByTestId('location-probe')).toHaveTextContent(`/projects/${createdProject.id}`));
    expect(createProjectMock).toHaveBeenCalledWith(
      { name: createdProject.name, relativeRoot: createdProject.relativeRoot },
      'csrf-value'
    );
    expect(store.getState().project.projects).toContainEqual(createdProject);
  });

  it('rejects unsafe relative roots locally, preserves the draft, and does not call the API', async () => {
    renderDashboard();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('project-create-trigger'));
    const rootInput = screen.getByLabelText('Folder inside your workspace');
    await user.type(screen.getByLabelText('Project name'), 'Unsafe project');
    await user.type(rootInput, '../outside');
    await user.click(screen.getByTestId('project-create-submit'));

    expect(screen.getByTestId('project-relative-root-error')).toHaveTextContent('relative folder');
    expect(rootInput).toHaveValue('../outside');
    expect(rootInput).toHaveFocus();
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it('maps a server overlap error to the root field without exposing server details', async () => {
    createProjectMock.mockRejectedValue(new ApiClientError(409, 'PROJECT_ROOT_OVERLAP', 'internal root detail', [{
      field: 'relativeRoot',
      message: 'internal overlap detail'
    }]));
    renderDashboard();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('project-create-trigger'));
    await user.type(screen.getByLabelText('Project name'), 'Overlapping project');
    await user.type(screen.getByLabelText('Folder inside your workspace'), 'apps/website-child');
    await user.click(screen.getByTestId('project-create-submit'));

    expect(await screen.findByTestId('project-relative-root-error')).toHaveTextContent(
      'already used by another active project'
    );
    expect(screen.queryByText('internal overlap detail')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Folder inside your workspace')).toHaveFocus();
  });

  it('archives an active project only after confirmation and shows its archived representation', async () => {
    const archivedProject = { ...ACTIVE_PROJECT, status: 'archived' as const, version: 2 };
    updateProjectStatusMock.mockResolvedValue(archivedProject);
    const store = renderDashboard();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('project-archive-trigger'));
    expect(screen.getByRole('alertdialog', { name: 'Archive project?' })).toBeInTheDocument();
    expect(screen.getByTestId('project-archive-cancel')).toHaveFocus();
    await user.click(screen.getByTestId('project-archive-cancel'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(updateProjectStatusMock).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('project-archive-trigger'));
    await user.click(screen.getByTestId('project-archive-confirm'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Archived projects' })).toBeInTheDocument());
    expect(updateProjectStatusMock).toHaveBeenCalledWith(ACTIVE_PROJECT.id, 'archived', 1, 'csrf-value');
    expect(store.getState().project.projects).toContainEqual(archivedProject);
    expect(screen.getByTestId('project-archived-status')).toBeInTheDocument();
  });

  it('restores an archived project and returns it to the active list', async () => {
    const restoredProject = { ...ARCHIVED_PROJECT, status: 'active' as const, version: 3 };
    updateProjectStatusMock.mockResolvedValue(restoredProject);
    const store = renderDashboard({ ...PROJECT_STATE, projects: [ARCHIVED_PROJECT] });
    const user = userEvent.setup();

    await user.click(screen.getByTestId('project-restore-trigger'));
    expect(screen.getByRole('alertdialog', { name: 'Restore project?' })).toBeInTheDocument();
    expect(screen.getByTestId('project-restore-cancel')).toHaveFocus();
    await user.click(screen.getByTestId('project-restore-confirm'));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Active projects' })).toBeInTheDocument());
    expect(updateProjectStatusMock).toHaveBeenCalledWith(ARCHIVED_PROJECT.id, 'active', ARCHIVED_PROJECT.version, 'csrf-value');
    expect(store.getState().project.projects).toContainEqual(restoredProject);
    expect(screen.getByTestId('project-active-status')).toBeInTheDocument();
  });

  it('fails closed when the workspace boundary is unavailable and disables creation', () => {
    renderDashboard({ listStatus: 'error', projects: [], errorCode: 'WORKSPACE_BOUNDARY_UNAVAILABLE', detailById: {} });

    expect(screen.getByTestId('workspace-boundary-error')).toHaveTextContent('authoritative workspace is unavailable');
    expect(screen.getByTestId('project-create-trigger')).toBeDisabled();
    expect(screen.getByTestId('workspace-boundary-retry-button')).toBeInTheDocument();
    expect(screen.queryByTestId('project-empty-state')).not.toBeInTheDocument();
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

    await user.click(screen.getByTestId('project-create-trigger'));
    await user.type(screen.getByLabelText('Project name'), 'Expired project');
    await user.type(screen.getByLabelText('Folder inside your workspace'), 'expired');
    await user.click(screen.getByTestId('project-create-submit'));
    await waitFor(() => expect(store.getState().userSession.status).toBe('unauthenticated'));
    unregister();
  });

  it('clears the session when archive returns 401', async () => {
    updateProjectStatusMock.mockRejectedValue(new ApiClientError(401, 'SESSION_UNAUTHENTICATED', 'expired'));
    const store = renderDashboard({ ...PROJECT_STATE, projects: [ACTIVE_PROJECT, ARCHIVED_PROJECT] });
    const unregister = registerSessionExpiryHandler(() => store.dispatch(sessionCleared('SESSION_UNAUTHENTICATED')));
    const user = userEvent.setup();

    await user.click(screen.getAllByTestId('project-archive-trigger')[0]);
    await user.click(screen.getByTestId('project-archive-confirm'));
    await waitFor(() => expect(store.getState().userSession.status).toBe('unauthenticated'));
    unregister();
  });

  it('clears the session when restore returns 401', async () => {
    updateProjectStatusMock.mockRejectedValue(new ApiClientError(401, 'SESSION_UNAUTHENTICATED', 'expired'));
    const store = renderDashboard({ ...PROJECT_STATE, projects: [ARCHIVED_PROJECT] });
    const unregister = registerSessionExpiryHandler(() => store.dispatch(sessionCleared('SESSION_UNAUTHENTICATED')));
    const user = userEvent.setup();

    await user.click(screen.getByTestId('project-restore-trigger'));
    await user.click(screen.getByTestId('project-restore-confirm'));
    await waitFor(() => expect(store.getState().userSession.status).toBe('unauthenticated'));
    unregister();
  });

  it('keeps a boundary archive failure open with a directly focused retry', async () => {
    updateProjectStatusMock.mockRejectedValue(new ApiClientError(503, 'WORKSPACE_BOUNDARY_UNAVAILABLE', 'boundary detail'));
    listProjectsMock.mockResolvedValue({ projects: [ACTIVE_PROJECT] });
    const store = renderDashboard();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('project-archive-trigger'));
    await user.click(screen.getByTestId('project-archive-confirm'));
    expect(await screen.findByTestId('workspace-boundary-retry-button')).toHaveFocus();
    expect(screen.getByTestId('project-archive-confirm')).toBeDisabled();
    await user.click(screen.getByTestId('workspace-boundary-retry-button'));
    expect(screen.getByTestId('project-archive-confirm')).toBeEnabled();
    expect(screen.getByTestId('project-archive-dialog')).toBeInTheDocument();
    expect(store.getState().project.projects).toContainEqual(ACTIVE_PROJECT);
  });
});
