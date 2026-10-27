import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectSnapshot } from '@/entities/project';
import { HomeTaskCapture } from '@/features/task-capture/ui/HomeTaskCapture';

const { createGlobalTaskMock } = vi.hoisted(() => ({ createGlobalTaskMock: vi.fn() }));
vi.mock('@/entities/project-task', () => ({ createGlobalTask: createGlobalTaskMock }));

const WORKSPACE: ProjectSnapshot = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Studio refresh', slug: 'studio-refresh', workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false },
  status: 'active', version: 3, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
};
const item = { task: { id: 'task-1', projectId: WORKSPACE.id }, collection: 'workspace', workspace: { id: WORKSPACE.id, name: WORKSPACE.name, status: 'active' } };
function renderCapture(options: { readonly workspaces?: readonly ProjectSnapshot[]; readonly workspaceStatus?: 'loading' | 'success' | 'error'; readonly onCreated?: () => void } = {}) {
  const onCreated = options.onCreated ?? vi.fn();
  render(<MemoryRouter initialEntries={['/dashboard']}><Routes>
    <Route path="/dashboard" element={<HomeTaskCapture isOpen csrfToken="csrf" workspaces={options.workspaces ?? [WORKSPACE]} workspaceStatus={options.workspaceStatus ?? 'success'} onCreated={onCreated} onClose={vi.fn()} />} />
    <Route path="/tasks/:taskId" element={<h1>Task detail</h1>} />
  </Routes></MemoryRouter>);
  return { onCreated };
}

describe('HomeTaskCapture', () => {
  beforeEach(() => {
    createGlobalTaskMock.mockReset();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
  });

  afterEach(() => vi.restoreAllMocks());

  it('focuses the title and creates an assigned task through the canonical API', async () => {
    createGlobalTaskMock.mockResolvedValue({ item, replayed: false });
    const onCreated = vi.fn();
    renderCapture({ onCreated });
    const user = userEvent.setup();
    const title = screen.getByRole('textbox', { name: 'Task title' });
    await waitFor(() => expect(title).toHaveFocus());
    await user.type(title, 'Prepare the launch');
    await user.selectOptions(screen.getByLabelText('Workspace (optional)'), WORKSPACE.id);
    await user.click(screen.getByRole('button', { name: 'Add task' }));

    expect(await screen.findByTestId('home-task-capture-success')).toHaveTextContent('Task added.');
    expect(createGlobalTaskMock).toHaveBeenCalledWith({ title: 'Prepare the launch', details: null, workspaceId: WORKSPACE.id }, 'csrf', '11111111-1111-4111-8111-111111111111');
    expect(screen.getByRole('link', { name: 'View task' })).toHaveAttribute('href', '/tasks/task-1');
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it('defaults to Unassigned and explains that capture can continue when workspace choices fail', async () => {
    createGlobalTaskMock.mockResolvedValue({ item: { ...item, task: { ...item.task, projectId: null }, collection: 'inbox', workspace: null }, replayed: false });
    renderCapture({ workspaces: [], workspaceStatus: 'error' });
    expect(screen.getByLabelText('Workspace (optional)')).toHaveValue('');
    expect(screen.getByText('Workspace choices are unavailable. You can still add this task as Unassigned.')).toBeInTheDocument();
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Task title' }), 'Sort receipts');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add task' }));

    expect(createGlobalTaskMock).toHaveBeenCalledWith({ title: 'Sort receipts', details: null, workspaceId: null }, 'csrf', '11111111-1111-4111-8111-111111111111');
    expect(await screen.findByTestId('home-task-capture-success')).toBeInTheDocument();
  });

  it('retains an unknown request and retries with the same workspace and idempotency key', async () => {
    createGlobalTaskMock.mockRejectedValueOnce(new TypeError('connection closed')).mockResolvedValueOnce({ item, replayed: true });
    renderCapture();
    const user = userEvent.setup();
    const title = screen.getByRole('textbox', { name: 'Task title' });
    await user.type(title, 'Send the draft');
    await user.selectOptions(screen.getByLabelText('Workspace (optional)'), WORKSPACE.id);
    await user.click(screen.getByRole('button', { name: 'Add task' }));

    expect(await screen.findByTestId('home-task-capture-error')).toBeInTheDocument();
    expect(title).toBeDisabled();
    expect(title).toHaveValue('Send the draft');
    await user.click(screen.getByTestId('home-task-capture-retry'));
    await waitFor(() => expect(createGlobalTaskMock).toHaveBeenCalledTimes(2));
    expect(createGlobalTaskMock.mock.calls[0]).toEqual(createGlobalTaskMock.mock.calls[1]);
    expect(await screen.findByTestId('home-task-capture-success')).toBeInTheDocument();
  });

  it('explains an overlong title and preserves it for correction', async () => {
    renderCapture();
    const title = screen.getByRole('textbox', { name: 'Task title' });
    fireEvent.change(title, { target: { value: 'x'.repeat(121) } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a task title of 1 to 120 characters.');
    expect(title).toHaveValue('x'.repeat(121));
    expect(title).toHaveFocus();
    expect(createGlobalTaskMock).not.toHaveBeenCalled();
  });

  it('explains an empty title and associates the message with the input', async () => {
    renderCapture();
    const title = screen.getByRole('textbox', { name: 'Task title' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a task title of 1 to 120 characters.');
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(title).toHaveAttribute('aria-describedby', 'home-task-title-error');
    expect(title).toHaveFocus();
    expect(createGlobalTaskMock).not.toHaveBeenCalled();
  });
});
