import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectReducer } from '@/entities/project';
import type { ProjectTask } from '@/entities/project-task';
import { userSessionReducer } from '@/entities/user-session';
import { ProjectTasksPage } from '@/pages/project-tasks/ProjectTasksPage';

const { getProjectMock, listProjectTasksMock } = vi.hoisted(() => ({ getProjectMock: vi.fn(), listProjectTasksMock: vi.fn() }));
vi.mock('@/entities/project/api/project-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/project/api/project-api')>(), getProject: getProjectMock
}));
vi.mock('@/entities/project-task/api/project-task-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/project-task/api/project-task-api')>(), listProjectTasks: listProjectTasksMock
}));

const project = { id: 'project', name: 'Website', slug: 'website', workspaceMode: 'file_backed' as const, capabilities: { planning: true as const, fileAccess: true }, status: 'active' as const, version: 1, createdAt: '2026-10-05', updatedAt: '2026-10-05' };
const targetedTask: ProjectTask = { id: 'target', projectId: project.id, title: 'Review guide', details: 'The task selected from Home.', status: 'done', importance: 'medium', deadline: null, subtasks: [], position: 0, version: 1,
  source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null }, createdAt: '2026-10-01', updatedAt: '2026-10-01', completedAt: '2026-10-01', archivedAt: null };

describe('ProjectTasksPage Home task deep link', () => {
  beforeEach(() => {
    getProjectMock.mockReset(); listProjectTasksMock.mockReset();
    getProjectMock.mockResolvedValue(project);
    listProjectTasksMock.mockImplementation(async (_projectId: string, filter: string) => ({ tasks: filter === 'all' ? [targetedTask] : [], orderVersion: 1 }));
  });

  it('opens the referenced task even when it completed after appearing on Home', async () => {
    const store = configureStore({ reducer: { project: projectReducer, userSession: userSessionReducer }, preloadedState: {
      project: { listStatus: 'success' as const, projects: [project], errorCode: null, detailById: { [project.id]: { status: 'idle' as const, project: null, errorCode: null } } },
      userSession: { status: 'authenticated' as const, principal: { id: 'user', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const }, csrfToken: 'csrf', expiresAt: '2099-01-01', errorCode: null }
    } });
    render(<Provider store={store}><MemoryRouter initialEntries={['/projects/project/tasks?task=target']}><Routes><Route path="/projects/:projectId/tasks" element={<ProjectTasksPage />} /></Routes></MemoryRouter></Provider>);
    const title = await screen.findByText('Review guide');
    const summary = title.closest('summary');
    await waitFor(() => expect(summary?.parentElement).toHaveAttribute('open'));
    expect(summary).toHaveFocus();
    expect(screen.getByText('The task selected from Home.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(listProjectTasksMock).toHaveBeenCalledWith(project.id, 'all');
  });
});
