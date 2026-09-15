import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectReducer, type ProjectState } from '@/entities/project';
import { sessionCleared, userSessionReducer } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { registerSessionExpiryHandler } from '@/shared/api';
import { ProjectWorkspacePage } from '@/pages/project-workspace/ProjectWorkspacePage';

const { getProjectMock } = vi.hoisted(() => ({ getProjectMock: vi.fn() }));

vi.mock('@/entities/project/api/project-api', () => ({
  getProject: getProjectMock,
  listProjects: vi.fn(),
  createProject: vi.fn(),
  updateProjectStatus: vi.fn()
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const session = {
  status: 'authenticated' as const,
  principal: { id: 'user-1', displayName: 'Local user' },
  csrfToken: 'csrf-value',
  expiresAt: '2026-09-13T00:00:00.000Z',
  errorCode: null
};

function renderWorkspace(detail: ProjectState['detailById'][string]) {
  const projectState: ProjectState = {
    listStatus: 'success',
    projects: [],
    errorCode: null,
    detailById: { [PROJECT_ID]: detail }
  };
  const store = configureStore({
    reducer: { project: projectReducer, userSession: userSessionReducer },
    preloadedState: { project: projectState, userSession: session }
  });

  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}`]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectWorkspacePage />} />
        </Routes>
      </MemoryRouter>
    </Provider>
  );
  return store;
}

describe('ProjectWorkspacePage boundary errors', () => {
  beforeEach(() => {
    getProjectMock.mockReset();
  });

  it('shows a safe retryable boundary error instead of a false not-found state', async () => {
    getProjectMock.mockRejectedValue(new ApiClientError(503, 'WORKSPACE_BOUNDARY_UNAVAILABLE', 'absolute host detail'));
    renderWorkspace({ status: 'error', project: null, errorCode: 'WORKSPACE_BOUNDARY_UNAVAILABLE' });

    expect(await screen.findByTestId('workspace-boundary-error')).toHaveTextContent('authoritative workspace is unavailable');
    expect(screen.getByTestId('workspace-boundary-retry-button')).toBeInTheDocument();
    expect(screen.queryByTestId('project-not-found-state')).not.toBeInTheDocument();
    expect(screen.queryByText('absolute host detail')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('workspace-boundary-retry-button'));
    await waitFor(() => expect(getProjectMock).toHaveBeenCalledWith(PROJECT_ID));
  });

  it('reserves not-found copy for PROJECT_NOT_FOUND and retries network failures', async () => {
    getProjectMock.mockRejectedValue(new ApiClientError(503, 'INTERNAL_ERROR', 'internal detail'));
    renderWorkspace({ status: 'error', project: null, errorCode: 'INTERNAL_ERROR' });

    expect(await screen.findByTestId('project-detail-error')).toHaveTextContent('Try again');
    expect(screen.queryByTestId('project-not-found-state')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('project-detail-retry-button'));
    await waitFor(() => expect(getProjectMock).toHaveBeenCalledWith(PROJECT_ID));
  });

  it('keeps generic not-found copy for a project-not-found response', async () => {
    getProjectMock.mockRejectedValue(new ApiClientError(404, 'PROJECT_NOT_FOUND', 'not found'));
    renderWorkspace({ status: 'error', project: null, errorCode: 'PROJECT_NOT_FOUND' });

    expect(await screen.findByTestId('project-not-found-state')).toBeInTheDocument();
    expect(screen.queryByTestId('project-detail-error')).not.toBeInTheDocument();
  });

  it('clears the session when project detail returns 401', async () => {
    getProjectMock.mockRejectedValue(new ApiClientError(401, 'SESSION_UNAUTHENTICATED', 'expired'));
    const store = configureStore({
      reducer: { project: projectReducer, userSession: userSessionReducer },
      preloadedState: {
        project: { listStatus: 'success', projects: [], errorCode: null, detailById: { [PROJECT_ID]: { status: 'idle', project: null, errorCode: null } } } as ProjectState,
        userSession: session
      }
    });
    const unregister = registerSessionExpiryHandler(() => store.dispatch(sessionCleared('SESSION_UNAUTHENTICATED')));
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}`]}>
          <Routes><Route path="/projects/:projectId" element={<ProjectWorkspacePage />} /></Routes>
        </MemoryRouter>
      </Provider>
    );

    await waitFor(() => expect(store.getState().userSession.status).toBe('unauthenticated'));
    unregister();
  });
});
