import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskDetailPage } from '@/pages/task-detail/TaskDetailPage';

const { getGlobalTaskMock } = vi.hoisted(() => ({ getGlobalTaskMock: vi.fn() }));
vi.mock('@/entities/project-task/api/global-task-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/project-task/api/global-task-api')>(), getGlobalTask: getGlobalTaskMock
}));

const inboxItem = {
  task: { id: 'stable-task-id', projectId: null, title: 'Send the proposal', details: 'Review the draft.', importance: 'medium', deadline: null,
    subtasks: [{ id: 'subtask-1', title: 'Check dates', completed: false }], status: 'todo', position: 0, version: 1,
    source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', completedAt: null, archivedAt: null },
  collection: 'inbox', workspace: null
} as const;

describe('TaskDetailPage', () => {
  beforeEach(() => { getGlobalTaskMock.mockReset().mockResolvedValue(inboxItem); });

  it('loads by stable task ID and shows Inbox location and saved fields', async () => {
    render(<MemoryRouter initialEntries={['/tasks/stable-task-id']}><Routes><Route path="/tasks/:taskId" element={<TaskDetailPage />} /></Routes></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Send the proposal' })).toBeInTheDocument();
    expect(screen.getByText('Inbox', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Review the draft.')).toBeInTheDocument();
    expect(screen.getByText('Check dates')).toBeInTheDocument();
    expect(getGlobalTaskMock).toHaveBeenCalledWith('stable-task-id', false);
  });

  it('requests archived detail only for an explicit historical URL', async () => {
    const archivedItem = { ...inboxItem, task: { ...inboxItem.task, status: 'archived', archivedAt: '2026-10-16T00:00:00.000Z' } };
    getGlobalTaskMock.mockResolvedValue(archivedItem);
    render(<MemoryRouter initialEntries={['/tasks/stable-task-id?includeArchived=true']}><Routes><Route path="/tasks/:taskId" element={<TaskDetailPage />} /></Routes></MemoryRouter>);
    expect(await screen.findByTestId('task-detail-archived')).toHaveTextContent('historical read-only');
    expect(getGlobalTaskMock).toHaveBeenCalledWith('stable-task-id', true);
  });
});
