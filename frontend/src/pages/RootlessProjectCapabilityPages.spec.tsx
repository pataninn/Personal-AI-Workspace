import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { projectReducer, type ProjectSnapshot, type ProjectState } from '@/entities/project';
import { userSessionReducer } from '@/entities/user-session';
import { ProjectActivityPage } from '@/pages/project-activity';
import { ProjectContextPage } from '@/pages/project-context';
import { ProjectFileHistoryPage } from '@/pages/project-file-history';

const { getProjectMock, panelMocks } = vi.hoisted(() => ({
  getProjectMock: vi.fn(),
  panelMocks: { context: vi.fn(), activity: vi.fn(), history: vi.fn() }
}));

vi.mock('@/entities/project/api/project-api', () => ({
  getProject: getProjectMock,
  listProjects: vi.fn(),
  createProject: vi.fn(),
  updateProjectStatus: vi.fn()
}));

vi.mock('@/features/project-context', () => ({
  ProjectContextSettings: () => { panelMocks.context(); return null; }
}));
vi.mock('@/features/project-activity', () => ({
  ProjectActivityPanel: () => { panelMocks.activity(); return null; }
}));
vi.mock('@/features/project-file-history', () => ({
  ProjectFileHistoryPanel: () => { panelMocks.history(); return null; }
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT: ProjectSnapshot = {
  id: PROJECT_ID, name: 'Launch plan', slug: 'launch-plan', workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false },
  objective: 'Plan the launch', status: 'active', version: 1,
  createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z'
};

const userSession = {
  status: 'authenticated' as const,
  principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const },
  csrfToken: 'csrf-value',
  expiresAt: '2026-10-06T00:00:00.000Z',
  errorCode: null
};

function renderRootlessPage(path: string, page: ReactNode): void {
  const projectState: ProjectState = {
    listStatus: 'success', projects: [PROJECT], errorCode: null,
    detailById: { [PROJECT_ID]: { status: 'success', project: PROJECT, errorCode: null } }
  };
  const store = configureStore({
    reducer: { project: projectReducer, userSession: userSessionReducer },
    preloadedState: { project: projectState, userSession }
  });

  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/projects/:projectId/*" element={page} /></Routes>
      </MemoryRouter>
    </Provider>
  );
}

describe('planning-only project capability routes', () => {
  beforeEach(() => {
    getProjectMock.mockReset().mockResolvedValue(PROJECT);
    panelMocks.context.mockReset();
    panelMocks.activity.mockReset();
    panelMocks.history.mockReset();
  });

  it.each([
    { suffix: 'context', page: <ProjectContextPage />, panel: 'context' as const, alert: 'project-context-file-access-unavailable' },
    { suffix: 'activity', page: <ProjectActivityPage />, panel: 'activity' as const, alert: 'project-activity-file-access-unavailable' },
    { suffix: 'file-history?path=README.md', page: <ProjectFileHistoryPage />, panel: 'history' as const, alert: 'file-history-file-access-unavailable' }
  ])('gates a direct $suffix visit before mounting its folder-bound panel', async ({ suffix, page, panel, alert }) => {
    renderRootlessPage(`/projects/${PROJECT_ID}/${suffix}`, page);

    expect(await screen.findByTestId(alert)).toHaveTextContent('unavailable');
    expect(screen.getByRole('link', { name: 'Back to project' })).toHaveAttribute('href', `/projects/${PROJECT_ID}`);
    expect(panelMocks[panel]).not.toHaveBeenCalled();
    expect(getProjectMock).toHaveBeenCalledWith(PROJECT_ID);
  });
});
