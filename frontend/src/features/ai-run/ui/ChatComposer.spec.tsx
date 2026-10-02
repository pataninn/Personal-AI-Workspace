import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userSessionReducer } from '@/entities/user-session';
import type { AiRunSnapshot } from '@/entities/ai-run';
import { ChatComposer } from '@/features/ai-run/ui/ChatComposer';

const { sendMock, getRunMock, getHistoryMock } = vi.hoisted(() => ({ sendMock: vi.fn(), getRunMock: vi.fn(), getHistoryMock: vi.fn() }));
vi.mock('@/entities/ai-run', async (importOriginal) => ({ ...await importOriginal<typeof import('@/entities/ai-run')>(), sendChatMessage: sendMock, getAiRun: getRunMock }));
vi.mock('@/entities/conversation', async (importOriginal) => ({ ...await importOriginal<typeof import('@/entities/conversation')>(), getConversation: getHistoryMock }));
vi.mock('@/features/ai-run/ui/AiRunTimeline', () => ({ AiRunTimeline: () => <p>Assistant is working</p> }));
const run: AiRunSnapshot = { runId: 'run-1', projectId: 'project-1', conversationId: 'conversation-1', status: 'queued', phase: 'inference',
  decision: 'approved', manifestHash: 'a'.repeat(64), cleanup: 'not_started', providerTransmission: 'not_started', stagingItemCount: 0,
  safeMessage: 'Starting assistant run.' };

function renderComposer(disabled = false): ReturnType<typeof vi.fn> {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: {
    status: 'authenticated' as const, principal: { id: 'owner', displayName: 'User' }, csrfToken: 'csrf', expiresAt: null, errorCode: null
  } } });
  const onHistory = vi.fn();
  render(<Provider store={store}><MemoryRouter><ChatComposer projectId="project-1" conversationId="conversation-1" disabled={disabled} onConversationReconciled={onHistory} /></MemoryRouter></Provider>);
  return onHistory;
}

describe('ChatComposer', () => {
  beforeEach(() => { sendMock.mockReset().mockResolvedValue(run); getRunMock.mockReset().mockResolvedValue(run); getHistoryMock.mockReset().mockResolvedValue({ messages: [] }); });
  it('sends directly without Save message or a provider approval dialog and clears the draft', async () => {
    const onHistory = renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Continue our earlier chat');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onHistory).toHaveBeenCalled());
    expect(sendMock).toHaveBeenCalledWith('project-1', 'conversation-1', 'Continue our earlier chat', 'csrf', expect.any(String));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Save message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
  it('keeps the draft and idempotency key when retrying a failed send', async () => {
    sendMock.mockRejectedValueOnce(new Error('Network failed'));
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'My draft');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Keep your draft');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('My draft');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(sendMock.mock.calls[0]?.[4]).toBe(sendMock.mock.calls[1]?.[4]);
  });
  it('sends with Ctrl+Enter', async () => {
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Keyboard request');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
  });
  it('keeps archived chats read-only', () => {
    renderComposer(true);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
