import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userSessionReducer } from '@/entities/user-session';
import { ProjectContextSettings } from '@/features/project-context/ui/ProjectContextSettings';

const { getContextMock, updateContextMock, treeMock } = vi.hoisted(() => ({ getContextMock: vi.fn(), updateContextMock: vi.fn(), treeMock: vi.fn() }));
vi.mock('@/entities/project/api/project-chat-context-api', () => ({ getProjectChatContext: getContextMock, updateProjectChatContext: updateContextMock }));
vi.mock('@/entities/workspace', async (importOriginal) => ({ ...await importOriginal<typeof import('@/entities/workspace')>(), getWorkspaceTree: treeMock }));

function renderSettings(archived = false): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: {
    status: 'authenticated' as const, principal: { id: 'owner', displayName: 'User' }, csrfToken: 'csrf', expiresAt: null, errorCode: null
  } } });
  render(<Provider store={store}><MemoryRouter><ProjectContextSettings projectId="project-1" archived={archived} /></MemoryRouter></Provider>);
}

describe('ProjectContextSettings', () => {
  beforeEach(() => {
    getContextMock.mockReset().mockResolvedValue({ relativePaths: ['README.md'], factIds: ['fact-1'], includeProjectConversations: true });
    updateContextMock.mockReset().mockImplementation(async (_project, changes) => ({ relativePaths: [], factIds: ['fact-1'], includeProjectConversations: true, ...changes }));
    treeMock.mockReset().mockResolvedValue({ entries: [{ type: 'file', path: 'README.md', name: 'README.md', sizeBytes: 12 }, { type: 'file', path: 'app.ts', name: 'app.ts', sizeBytes: 10 }], truncated: false });
  });
  it('loads stored choices and applies files across all chats without overwriting memory selections', async () => {
    renderSettings();
    const user = userEvent.setup();
    const readme = await screen.findByRole('checkbox', { name: 'README.md' });
    await waitFor(() => expect(readme).toBeChecked());
    expect(screen.getByRole('checkbox', { name: /Include recent messages/ })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'app.ts' }));
    await user.click(screen.getByRole('button', { name: 'Apply to all chats' }));
    await waitFor(() => expect(updateContextMock).toHaveBeenCalledWith('project-1', { relativePaths: ['README.md', 'app.ts'], includeProjectConversations: true }, 'csrf'));
    expect(await screen.findByText('Context applied to all chats in this project.')).toBeInTheDocument();
  });
  it('keeps the draft selection after a save fails', async () => {
    updateContextMock.mockRejectedValue(new Error('Network failure'));
    renderSettings();
    const user = userEvent.setup();
    const file = await screen.findByRole('checkbox', { name: 'app.ts' });
    await waitFor(() => expect(file).toBeEnabled());
    await user.click(file);
    await user.click(screen.getByRole('button', { name: 'Apply to all chats' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Context could not be saved');
    expect(file).toBeChecked();
  });
  it('disables editing for an archived project', async () => {
    renderSettings(true);
    expect(await screen.findByRole('checkbox', { name: 'README.md' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply to all chats' })).toBeDisabled();
  });
});
