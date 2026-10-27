import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userSessionReducer } from '@/entities/user-session';
import type { ConversationSnapshot } from '@/entities/conversation';
import { NewConversationButton } from '@/features/conversation-management/ui/NewConversationButton';

const { createConversationMock } = vi.hoisted(() => ({ createConversationMock: vi.fn() }));

vi.mock('@/entities/conversation/api/conversation-api', () => ({
  createConversation: createConversationMock,
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  createMessage: vi.fn()
}));

const conversation: ConversationSnapshot = {
  id: '44444444-4444-4444-8444-000000000001',
  projectId: '11111111-1111-4111-8111-111111111111',
  title: 'Research notes',
  status: 'active',
  lastActivityAt: '2026-09-12T12:00:00.000Z',
  createdAt: '2026-09-12T12:00:00.000Z',
  updatedAt: '2026-09-12T12:00:00.000Z'
};

const session = {
  status: 'authenticated' as const,
  principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const },
  csrfToken: 'csrf-token',
  expiresAt: '2026-09-13T00:00:00.000Z',
  errorCode: null
};

function renderButton(disabled = false) {
  const onCreated = vi.fn();
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: session } });
  render(<Provider store={store}><NewConversationButton projectId={conversation.projectId} disabled={disabled} onCreated={onCreated} /></Provider>);
  return { onCreated };
}

describe('NewConversationButton', () => {
  beforeEach(() => createConversationMock.mockReset());
  it('opens a new chat directly without asking for a title', async () => {
    createConversationMock.mockResolvedValue(conversation);
    const { onCreated } = renderButton();
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(conversation));
    expect(createConversationMock).toHaveBeenCalledWith(conversation.projectId, { title: 'New chat' }, 'csrf-token', expect.any(String));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('retries an uncertain create with the same idempotency key', async () => {
    createConversationMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(conversation);
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(createConversationMock.mock.calls[0][3]).toEqual(createConversationMock.mock.calls[1][3]);
  });
  it('prevents creation in archived workspaces', () => {
    renderButton(true);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(createConversationMock).not.toHaveBeenCalled();
  });
});
