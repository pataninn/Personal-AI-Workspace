import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectReducer, type ProjectSnapshot, type ProjectState } from '@/entities/project';
import { userSessionReducer } from '@/entities/user-session';
import { WorkspacePlanningChatPage } from '@/pages/workspace-planning-chat';

const { getProjectMock } = vi.hoisted(() => ({ getProjectMock: vi.fn() }));

vi.mock('@/entities/project/api/project-api', () => ({
  getProject: getProjectMock,
  listProjects: vi.fn(),
  createProject: vi.fn(),
  removeProject: vi.fn(),
  updateProjectStatus: vi.fn()
}));
vi.mock('@/widgets/home-chat', () => ({
  HomeChatWidget: (props: {
    readonly scope: { readonly kind: string; readonly workspaceId?: string };
    readonly scopeLabel: string;
    readonly disabled?: boolean;
    readonly disabledReason?: string;
  }) => <section
    data-testid="planning-chat-widget"
    data-scope={props.scope.kind}
    data-workspace-id={props.scope.workspaceId}
    data-disabled={String(props.disabled ?? false)}
    data-disabled-reason={props.disabledReason}
  >{props.scopeLabel}</section>
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION = {
  status: 'authenticated' as const,
  principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const },
  csrfToken: 'csrf-value',
  expiresAt: '2026-10-16T00:00:00.000Z',
  errorCode: null
};

function workspace(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    id: PROJECT_ID,
    name: 'Launch plan',
    slug: 'launch-plan',
    workspaceMode: 'planning',
    capabilities: { planning: true, fileAccess: false },
    objective: 'Plan the launch',
    status: 'active',
    version: 1,
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
    ...overrides
  };
}

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="route-location">{`${location.pathname}${location.search}`}</output>;
}

function renderPlanningChat(project: ProjectSnapshot, conversationId: string | null = 'conversation-1'): void {
  const projectState: ProjectState = {
    listStatus: 'success',
    projects: [project],
    errorCode: null,
    detailById: { [PROJECT_ID]: { status: 'idle', project: null, errorCode: null } }
  };
  const store = configureStore({ reducer: { project: projectReducer, userSession: userSessionReducer }, preloadedState: { project: projectState, userSession: SESSION } });

  const query = conversationId ? `?conversation=${encodeURIComponent(conversationId)}` : '';
  render(<Provider store={store}><MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/planning-chat${query}`]}><Routes>
    <Route path="/projects/:projectId/planning-chat" element={<WorkspacePlanningChatPage />} />
    <Route path="/projects/:projectId" element={<p data-testid="existing-project-chat">Existing project chat</p>} />
    <Route path="/dashboard" element={<p>Home</p>} />
  </Routes><LocationProbe /></MemoryRouter></Provider>);
}

describe('WorkspacePlanningChatPage', () => {
  beforeEach(() => {
    getProjectMock.mockReset().mockResolvedValue(workspace());
  });

  it('loads a planning-only workspace into its own workspace-scoped text chat', async () => {
    const project = workspace();
    getProjectMock.mockResolvedValue(project);
    renderPlanningChat(project);

    const chat = await screen.findByTestId('planning-chat-widget');
    expect(chat).toHaveAttribute('data-scope', 'workspace');
    expect(chat).toHaveAttribute('data-workspace-id', PROJECT_ID);
    expect(chat).toHaveTextContent('Launch plan');
    expect(screen.getByTestId('route-location')).toHaveTextContent(`/projects/${PROJECT_ID}/planning-chat?conversation=conversation-1`);
    expect(screen.queryByTestId('existing-project-chat')).not.toBeInTheDocument();
  });

  it('keeps archived workspace history mounted with the chat controls disabled', async () => {
    const project = workspace({ status: 'archived' });
    getProjectMock.mockResolvedValue(project);
    renderPlanningChat(project);

    const chat = await screen.findByTestId('planning-chat-widget');
    expect(chat).toHaveAttribute('data-disabled', 'true');
    expect(chat).toHaveAttribute('data-disabled-reason', 'This workspace is archived. You can still read past conversations.');
  });

  it('redirects projects with file capability to the existing project chat', async () => {
    const project = workspace({ workspaceMode: 'file_backed', capabilities: { planning: true, fileAccess: true } });
    getProjectMock.mockResolvedValue(project);
    renderPlanningChat(project, null);

    expect(await screen.findByTestId('existing-project-chat')).toBeInTheDocument();
    expect(screen.getByTestId('route-location')).toHaveTextContent(`/projects/${PROJECT_ID}`);
    expect(screen.queryByTestId('planning-chat-widget')).not.toBeInTheDocument();
  });

  it('opens the saved Home result for a file-backed workspace only when a conversation is selected', async () => {
    const project = workspace({ workspaceMode: 'file_backed', capabilities: { planning: true, fileAccess: true } });
    getProjectMock.mockResolvedValue(project);
    renderPlanningChat(project, 'saved-run');

    const chat = await screen.findByTestId('planning-chat-widget');
    expect(chat).toHaveAttribute('data-scope', 'workspace');
    expect(chat).toHaveAttribute('data-workspace-id', PROJECT_ID);
    expect(screen.getByTestId('route-location')).toHaveTextContent(`/projects/${PROJECT_ID}/planning-chat?conversation=saved-run`);
    expect(screen.queryByTestId('existing-project-chat')).not.toBeInTheDocument();
  });
});
