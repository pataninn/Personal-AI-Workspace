import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionAuthenticated, userSessionReducer } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import type { ShowcasePreview } from '@/entities/showcase';
import { ShowcasePublisher } from '@/features/showcase-publishing/ui/ShowcasePublisher';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const SKILL_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listProjectTasks: vi.fn(),
  listProjectFacts: vi.fn(),
  listSkills: vi.fn(),
  getCurrentShowcase: vi.fn(),
  previewShowcase: vi.fn(),
  publishShowcase: vi.fn()
}));

vi.mock('@/entities/project', () => ({ listProjects: mocks.listProjects }));
vi.mock('@/entities/project-task', () => ({ listProjectTasks: mocks.listProjectTasks }));
vi.mock('@/entities/project-fact', () => ({ listProjectFacts: mocks.listProjectFacts }));
vi.mock('@/entities/skill', () => ({ listSkills: mocks.listSkills }));
vi.mock('@/entities/showcase', () => ({
  getCurrentShowcase: mocks.getCurrentShowcase,
  previewShowcase: mocks.previewShowcase,
  publishShowcase: mocks.publishShowcase
}));

function renderPublisher(): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer } });
  store.dispatch(sessionAuthenticated({
    principal: { id: 'admin-owner', displayName: 'Admin', accountKind: 'regular', role: 'admin' },
    csrfToken: 'csrf-admin',
    expiresAt: '2026-10-20T00:00:00.000Z'
  }));
  render(<Provider store={store}><MemoryRouter><ShowcasePublisher /></MemoryRouter></Provider>);
}

describe('ShowcasePublisher', () => {
  beforeEach(() => {
    mocks.listProjects.mockReset();
    mocks.listProjectTasks.mockReset();
    mocks.listProjectFacts.mockReset();
    mocks.listSkills.mockReset();
    mocks.getCurrentShowcase.mockReset();
    mocks.previewShowcase.mockReset();
    mocks.publishShowcase.mockReset();
    mocks.listProjects.mockResolvedValue({ projects: [{
      id: PROJECT_ID,
      name: 'Admin-owned project',
      slug: 'admin-owned-project',
      objective: null,
      workspaceMode: 'planning',
      capabilities: { planning: true, fileAccess: false },
      status: 'active',
      version: 1,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z'
    }] });
    mocks.listProjectTasks.mockResolvedValue({ tasks: [{
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: 'Sample task',
      details: null,
      importance: 'medium',
      deadline: null,
      subtasks: [],
      status: 'todo',
      position: 0,
      version: 1,
      source: { kind: 'user', label: 'Created by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
      completedAt: null,
    }], orderVersion: 1 });
    mocks.listProjectFacts.mockResolvedValue([]);
    mocks.listSkills.mockResolvedValue([{
      id: SKILL_ID, workspaceId: null, title: 'Plan helper', instructions: 'Prioritize open work.', declaredTools: ['home_task_read'],
      enabled: true, version: 1, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z'
    }]);
    mocks.getCurrentShowcase.mockRejectedValue(new ApiClientError(404, 'SHOWCASE_NOT_PUBLISHED', 'not published'));
    mocks.previewShowcase.mockResolvedValue({
      project: { name: 'Admin-owned project', objective: null },
      tasks: [{ title: 'Sample task', details: null, status: 'todo', importance: 'medium', deadline: null, checklist: [] }],
      facts: [],
      skills: [],
      files: [],
      previewDigest: 'a'.repeat(64),
      sourceRevision: 'b'.repeat(64),
      totals: { itemCount: 1, fileCount: 0, snapshotBytes: 10 },
      exclusions: ['Chats and histories']
    });
  });

  it('starts with no selected source items and previews only the explicit selection', async () => {
    const user = userEvent.setup();
    renderPublisher();
    const projectSelect = await screen.findByLabelText('Your active project');
    await user.selectOptions(projectSelect, PROJECT_ID);
    const taskCheckbox = await screen.findByRole('checkbox', { name: /Sample task/ });
    expect(taskCheckbox).not.toBeChecked();
    await user.click(taskCheckbox);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview selection' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Preview selection' }));

    expect(await screen.findByTestId('showcase-preview')).toBeInTheDocument();
    expect(mocks.previewShowcase).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      selection: { taskIds: [TASK_ID], factIds: [], skillIds: [], filePaths: [] }
    }, 'csrf-admin');
  });

  it('includes only explicitly selected eligible skills in the exact preview request', async () => {
    const user = userEvent.setup();
    renderPublisher();
    await user.selectOptions(await screen.findByLabelText('Your active project'), PROJECT_ID);
    const skillCheckbox = await screen.findByRole('checkbox', { name: /Plan helper/ });
    expect(skillCheckbox).not.toBeChecked();
    await user.click(skillCheckbox);
    await user.click(await screen.findByRole('button', { name: 'Preview selection' }));

    await screen.findByTestId('showcase-preview');
    expect(mocks.previewShowcase).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      selection: { taskIds: [], factIds: [], skillIds: [SKILL_ID], filePaths: [] }
    }, 'csrf-admin');
  });

  it('freezes project and item selections while an exact preview is in flight', async () => {
    const user = userEvent.setup();
    let resolvePreview: ((value: ShowcasePreview) => void) | undefined;
    mocks.previewShowcase.mockImplementation(() => new Promise<ShowcasePreview>((resolve) => { resolvePreview = resolve; }));
    renderPublisher();
    const projectSelect = await screen.findByLabelText('Your active project');
    await user.selectOptions(projectSelect, PROJECT_ID);
    const taskCheckbox = await screen.findByRole('checkbox', { name: /Sample task/ });
    await user.click(taskCheckbox);
    await user.click(await screen.findByRole('button', { name: 'Preview selection' }));

    await waitFor(() => expect(taskCheckbox).toBeDisabled());
    expect(projectSelect).toBeDisabled();
    expect(taskCheckbox).toBeChecked();
    await user.click(taskCheckbox);
    expect(taskCheckbox).toBeChecked();

    resolvePreview?.({
      project: { name: 'Admin-owned project', objective: null },
      tasks: [{ title: 'Sample task', details: null, status: 'todo', importance: 'medium', deadline: null, checklist: [] }],
      facts: [], skills: [], files: [], previewDigest: 'a'.repeat(64), sourceRevision: 'b'.repeat(64),
      totals: { itemCount: 1, fileCount: 0, snapshotBytes: 10 }, exclusions: ['Chats and histories']
    });
    expect(await screen.findByTestId('showcase-preview')).toBeInTheDocument();
    expect(mocks.previewShowcase).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      selection: { taskIds: [TASK_ID], factIds: [], skillIds: [], filePaths: [] }
    }, 'csrf-admin');
  });
});
