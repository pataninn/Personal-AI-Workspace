import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userSessionReducer } from '@/entities/user-session';
import type { MessageSnapshot } from '@/entities/message';
import { ApiClientError } from '@/shared/api';
import { MessageComposer } from '@/features/message-persistence/ui/MessageComposer';

const { createMessageMock } = vi.hoisted(() => ({ createMessageMock: vi.fn() }));

vi.mock('@/entities/conversation/api/conversation-api', () => ({
  createMessage: createMessageMock,
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn()
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-000000000001';
const message: MessageSnapshot = {
  id: '55555555-5555-4555-8555-000000000001',
  conversationId: CONVERSATION_ID,
  role: 'user',
  sequence: 1,
  content: 'Saved content',
  createdAt: '2026-09-12T12:00:00.000Z'
};

const session = {
  status: 'authenticated' as const,
  principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const },
  csrfToken: 'csrf-token',
  expiresAt: '2026-09-13T00:00:00.000Z',
  errorCode: null
};

function renderComposer(disabled = false, onSaved = vi.fn()): ReturnType<typeof vi.fn> {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: session } });
  render(
    <Provider store={store}>
      <MessageComposer projectId={PROJECT_ID} conversationId={CONVERSATION_ID} disabled={disabled} onSaved={onSaved} />
    </Provider>
  );
  return onSaved;
}

describe('MessageComposer', () => {
  beforeEach(() => {
    createMessageMock.mockReset();
  });

  it('validates whitespace without clearing the draft or calling the API', async () => {
    renderComposer();
    const user = userEvent.setup();
    const input = screen.getByLabelText('Message');
    await user.type(input, '   ');
    await user.click(screen.getByTestId('message-submit'));
    expect(await screen.findByTestId('message-input-error')).toHaveTextContent('Enter a message before saving.');
    expect(input).toHaveValue('   ');
    expect(createMessageMock).not.toHaveBeenCalled();
  });

  it('submits with Ctrl+Enter, blocks duplicate in-flight requests, and reconciles success', async () => {
    let resolveRequest: (value: MessageSnapshot) => void = () => undefined;
    createMessageMock.mockReturnValue(new Promise<MessageSnapshot>((resolve) => { resolveRequest = resolve; }));
    const onSaved = renderComposer(false);
    const user = userEvent.setup();
    const input = screen.getByLabelText('Message');
    await user.type(input, 'Saved content');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await user.click(screen.getByTestId('message-submit'));
    expect(createMessageMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('message-submit-status')).toHaveTextContent('Saving message');
    expect(screen.getByTestId('message-pending')).toHaveTextContent('Saving message');
    resolveRequest(message);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(message));
    expect(input).toHaveValue('');
    expect(screen.getByTestId('message-submit-status')).toHaveTextContent('Message saved.');
  });

  it('keeps a failed draft, retries with the same key, and maps server validation', async () => {
    createMessageMock.mockRejectedValueOnce(new Error('connection dropped')).mockResolvedValueOnce(message);
    renderComposer();
    const user = userEvent.setup();
    const input = screen.getByLabelText('Message');
    await user.type(input, 'Saved content');
    await user.click(screen.getByTestId('message-submit'));
    expect(await screen.findByTestId('message-save-error')).toHaveTextContent('Keep the draft and try again.');
    expect(input).toHaveValue('Saved content');
    await user.click(screen.getByTestId('message-retry-button'));
    await waitFor(() => expect(createMessageMock).toHaveBeenCalledTimes(2));
    expect(createMessageMock.mock.calls[1]?.[4]).toBe(createMessageMock.mock.calls[0]?.[4]);
    await waitFor(() => expect(input).toHaveValue(''));

    createMessageMock.mockRejectedValueOnce(new ApiClientError(400, 'MESSAGE_CONTENT_INVALID', 'invalid', [{ field: 'content', message: 'Server says no.' }]));
    await user.type(input, 'Invalid content');
    await user.click(screen.getByTestId('message-submit'));
    expect(await screen.findByTestId('message-input-error')).toHaveTextContent('Server says no.');
    expect(input).toHaveValue('Invalid content');
  });

  it('shows archived read-only copy and prevents submission', async () => {
    renderComposer(true);
    const input = screen.getByLabelText('Message');
    expect(input).toBeDisabled();
    expect(screen.getByTestId('message-submit')).toBeDisabled();
    expect(screen.getByTestId('project-archived-message')).toHaveTextContent('read-only');
    expect(createMessageMock).not.toHaveBeenCalled();
  });
});
