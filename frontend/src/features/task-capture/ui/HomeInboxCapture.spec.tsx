import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HomeInboxCapture } from '@/features/task-capture/ui/HomeInboxCapture';
import { userSessionReducer } from '@/entities/user-session';

const { createInboxTaskMock, getInboxTaskCountMock } = vi.hoisted(() => ({ createInboxTaskMock: vi.fn(), getInboxTaskCountMock: vi.fn() }));
vi.mock('@/entities/project-task', () => ({ createInboxTask: createInboxTaskMock, getInboxTaskCount: getInboxTaskCountMock }));

const item = {
  task: { id: 'task-1', projectId: null }, collection: 'inbox', workspace: null
};
const session = { status: 'authenticated' as const, principal: { id: 'user-1', displayName: 'Local user' }, csrfToken: 'csrf', expiresAt: '2099-01-01', errorCode: null };

function renderCapture(onCreated = vi.fn()) {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: session } });
  render(<Provider store={store}><MemoryRouter initialEntries={['/dashboard']}><Routes>
    <Route path="/dashboard" element={<HomeInboxCapture onCreated={onCreated} />} />
    <Route path="/tasks/:taskId" element={<h1>Task detail</h1>} />
    <Route path="/tasks" element={<h1>All tasks</h1>} />
  </Routes></MemoryRouter></Provider>);
  return onCreated;
}

describe('HomeInboxCapture', () => {
  beforeEach(() => {
    createInboxTaskMock.mockReset();
    getInboxTaskCountMock.mockReset().mockResolvedValue({ count: 0 });
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates an Inbox task, refreshes the canonical count, and returns focus to the title', async () => {
    getInboxTaskCountMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    createInboxTaskMock.mockResolvedValue({ item, replayed: false });
    const onCreated = renderCapture();
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Task title' });
    await user.type(input, 'Send the proposal');
    await user.click(screen.getByRole('button', { name: 'Save to Inbox' }));

    expect(await screen.findByTestId('home-inbox-saved')).toHaveTextContent('Saved to Inbox');
    expect(screen.getByTestId('home-inbox-count')).toHaveTextContent('01');
    expect(input).toHaveValue('');
    await waitFor(() => expect(input).toHaveFocus());
    expect(createInboxTaskMock).toHaveBeenCalledWith('Send the proposal', 'csrf', '11111111-1111-4111-8111-111111111111');
    expect(getInboxTaskCountMock).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('retries an unknown outcome with the same request identity and body', async () => {
    createInboxTaskMock.mockRejectedValueOnce(new TypeError('connection closed')).mockResolvedValueOnce({ item, replayed: true });
    renderCapture();
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Task title' });
    await user.type(input, 'Send the proposal');
    await user.click(screen.getByRole('button', { name: 'Save to Inbox' }));

    expect(await screen.findByTestId('home-inbox-save-error')).toBeInTheDocument();
    expect(input).toBeDisabled();
    await user.click(screen.getByTestId('home-inbox-retry'));
    await waitFor(() => expect(createInboxTaskMock).toHaveBeenCalledTimes(2));
    expect(createInboxTaskMock.mock.calls[0]).toEqual(createInboxTaskMock.mock.calls[1]);
    expect(await screen.findByTestId('home-inbox-saved')).toBeInTheDocument();
  });
});
