import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userSessionReducer } from '@/entities/user-session';
import type { ConversationSnapshot } from '@/entities/conversation';
import { ApiClientError } from '@/shared/api';
import { CreateConversationDialog } from '@/features/conversation-management/ui/CreateConversationDialog';

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

function renderDialog(onCreated = vi.fn(), onOpenChange = vi.fn()): { readonly onCreated: ReturnType<typeof vi.fn>; readonly onOpenChange: ReturnType<typeof vi.fn> } {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: session } });
  render(
    <Provider store={store}>
      <CreateConversationDialog projectId={conversation.projectId} open disabled={false} onOpenChange={onOpenChange} onCreated={onCreated} />
    </Provider>
  );
  return { onCreated, onOpenChange };
}

describe('CreateConversationDialog', () => {
  beforeEach(() => {
    createConversationMock.mockReset();
  });

  it('validates an empty title, focuses the field, and avoids a network request', async () => {
    renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('conversation-create-submit'));

    expect(await screen.findByTestId('conversation-title-error')).toHaveTextContent('Enter a conversation name.');
    expect(screen.getByTestId('conversation-title-input')).toHaveFocus();
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it('keeps the dialog pending and prevents duplicate submits', async () => {
    let resolveRequest: (value: ConversationSnapshot) => void = () => undefined;
    createConversationMock.mockReturnValue(new Promise<ConversationSnapshot>((resolve) => { resolveRequest = resolve; }));
    const callbacks = renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Conversation name'), 'Research notes');
    await user.click(screen.getByTestId('conversation-create-submit'));
    await user.click(screen.getByTestId('conversation-create-submit'));

    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('conversation-create-submit')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('conversation-create-status-message')).toHaveTextContent('Creating conversation');
    resolveRequest(conversation);
    await waitFor(() => expect(callbacks.onCreated).toHaveBeenCalledWith(conversation));
    expect(callbacks.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('preserves the title and idempotency key for a retry, then starts a new intent after a title change', async () => {
    createConversationMock
      .mockRejectedValueOnce(new Error('connection dropped'))
      .mockRejectedValueOnce(new ApiClientError(409, 'IDEMPOTENCY_KEY_REUSED', 'changed payload'))
      .mockResolvedValueOnce(conversation);
    renderDialog();
    const user = userEvent.setup();
    const input = screen.getByLabelText('Conversation name');
    await user.type(input, 'Research notes');
    await user.click(screen.getByTestId('conversation-create-submit'));
    await screen.findByTestId('conversation-create-error');
    await user.click(screen.getByTestId('conversation-create-submit'));
    const firstKey = createConversationMock.mock.calls[0]?.[3];
    const retryKey = createConversationMock.mock.calls[1]?.[3];
    expect(retryKey).toBe(firstKey);
    await user.clear(input);
    await user.type(input, 'Changed title');
    await user.click(screen.getByTestId('conversation-create-submit'));
    const changedKey = createConversationMock.mock.calls[2]?.[3];
    expect(changedKey).not.toBe(retryKey);
  });

  it('shows archived/read-only state through disabled controls', () => {
    const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: session } });
    render(
      <Provider store={store}>
        <CreateConversationDialog projectId={conversation.projectId} open disabled onOpenChange={vi.fn()} onCreated={vi.fn()} />
      </Provider>
    );
    expect(screen.getByTestId('conversation-create-submit')).toBeDisabled();
    expect(createConversationMock).not.toHaveBeenCalled();
  });
});
