import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssistantExecutionPolicyStatus } from '@/entities/assistant-policy';
import { userSessionReducer } from '@/entities/user-session';
import type { AiRunIntent, AiRunSnapshot } from '@/entities/ai-run';
import type { ConversationHistoryResponse } from '@/entities/conversation';
import { ChatComposer } from '@/features/ai-run/ui/ChatComposer';

const { sendMock, getRunMock, getManifestMock, decideMock, startMock, cancelMock, getHistoryMock, getPolicyMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getRunMock: vi.fn(),
  getManifestMock: vi.fn(),
  decideMock: vi.fn(),
  startMock: vi.fn(),
  cancelMock: vi.fn(),
  getHistoryMock: vi.fn(),
  getPolicyMock: vi.fn()
}));
const usageApi = vi.hoisted(() => ({ useAccountUsage: vi.fn() }));

vi.mock('@/entities/ai-run', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/ai-run')>(),
  sendChatMessage: sendMock,
  getAiRun: getRunMock,
  getEgressManifest: getManifestMock,
  decideEgress: decideMock,
  startAiRun: startMock,
  cancelAiRun: cancelMock
}));
vi.mock('@/entities/assistant-policy', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/assistant-policy')>(),
  getAssistantExecutionPolicy: getPolicyMock
}));
vi.mock('@/entities/account-usage', async (importOriginal) => ({ ...await importOriginal<typeof import('@/entities/account-usage')>(), ...usageApi }));
vi.mock('@/entities/conversation', async (importOriginal) => ({ ...await importOriginal<typeof import('@/entities/conversation')>(), getConversation: getHistoryMock }));
vi.mock('@/features/ai-run/ui/AiRunTimeline', () => ({ AiRunTimeline: () => <div data-testid="ai-run-timeline" /> }));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-000000000001';
const RUN_ID = '77777777-7777-4777-8777-000000000001';
const HASH = 'a'.repeat(64);
const pending: AiRunSnapshot = {
  runId: RUN_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, status: 'pending_approval', phase: 'decision',
  decision: 'pending', manifestHash: HASH, safeMessage: 'This older run is waiting for a decision.', cleanup: 'not_started',
  providerTransmission: 'not_started', stagingItemCount: 0
};
const autoStarted: AiRunIntent = {
  ...pending,
  status: 'running',
  phase: 'inference',
  decision: 'policy_authorized',
  safeMessage: 'Assistant run is working.'
};
const history: ConversationHistoryResponse = {
  conversation: { id: CONVERSATION_ID, projectId: PROJECT_ID, title: 'Current conversation', status: 'active', lastActivityAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
  messages: [], nextBeforeSequence: null
};
const readyPolicy: AssistantExecutionPolicyStatus = {
  scope: { kind: 'workspace', label: 'Project workspace' },
  policy: { enabled: true, revision: '4', provider: { name: 'NVIDIA hosted NIM', model: 'pinned-model' }, included: { categories: ['request'], items: [] }, exclusionsEnforced: true, capabilities: [] },
  fileAccess: true,
  readiness: { state: 'ready' }
};

function renderComposer(disabled = false, initialEntry = '/conversation'): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: {
    status: 'authenticated' as const, principal: { id: 'owner', displayName: 'User', accountKind: 'regular' as const, role: 'user' as const }, csrfToken: 'csrf', expiresAt: null, errorCode: null
  } } });
  render(<Provider store={store}><MemoryRouter initialEntries={[initialEntry]}><ChatComposer projectId={PROJECT_ID} conversationId={CONVERSATION_ID} history={history} disabled={disabled} onConversationReconciled={vi.fn()} /></MemoryRouter></Provider>);
}

describe('ChatComposer', () => {
  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue(autoStarted);
    getRunMock.mockReset().mockResolvedValue(autoStarted);
    getManifestMock.mockReset().mockResolvedValue({ runId: RUN_ID });
    decideMock.mockReset();
    startMock.mockReset();
    cancelMock.mockReset().mockResolvedValue({ ...pending, status: 'cancelled', decision: 'rejected' });
    getHistoryMock.mockReset().mockResolvedValue(history);
    getPolicyMock.mockReset().mockResolvedValue(readyPolicy);
    usageApi.useAccountUsage.mockReset().mockReturnValue({ state: { status: 'success', data: { availability: { status: 'available', canSubmit: true, reason: null } } }, refresh: vi.fn() });
  });

  it('sends under the loaded scope policy without a decision or separate start request', async () => {
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('message-input'), 'Continue our earlier chat');
    const submit = screen.getByTestId('ai-run-submit');
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    await waitFor(() => expect(sendMock).toHaveBeenCalledWith(PROJECT_ID, CONVERSATION_ID, 'Continue our earlier chat', 'csrf', expect.any(String)));
    await waitFor(() => expect(screen.getByTestId('message-input')).toHaveValue(''));
    const summary = screen.getByRole('region', { name: 'Assistant policy summary' });
    expect(summary).toHaveTextContent('Project workspace');
    expect(summary).toHaveTextContent('Workspace data is stored on the operator-managed deployment.');
    expect(summary).toHaveTextContent('When you submit an assistant request, selected context is sent to NVIDIA hosted NIM for processing.');
    expect(within(summary).getByRole('link', { name: 'Read NVIDIA API Trial Terms' })).toHaveAttribute('href', 'https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf');
    expect(within(summary).queryByRole('button', { name: /approve|accept/u })).not.toBeInTheDocument();
    expect(screen.queryByTestId('provider-consent-alert-dialog')).not.toBeInTheDocument();
    expect(decideMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('describes policy-bound staging without suggesting that a user approved it', async () => {
    sendMock.mockResolvedValueOnce({ ...autoStarted, status: 'staging', phase: 'staging' });
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('message-input'), 'Prepare a policy-bound request');
    await user.click(screen.getByTestId('ai-run-submit'));

    expect(await screen.findByTestId('run-staging')).toHaveTextContent('Preparing the policy-bound context');
    expect(screen.getByTestId('run-staging')).not.toHaveTextContent('approved context');
  });

  it('fails closed while policy is unavailable and keeps the draft', async () => {
    getPolicyMock.mockResolvedValueOnce({ ...readyPolicy, readiness: { state: 'unavailable', reasonCode: 'runtime_unverified' } });
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('message-input'), 'Keep this until policy is ready');

    expect(screen.getByTestId('ai-run-submit')).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('assistant-policy-readiness')).toHaveTextContent(/unavailable/i));
    expect(screen.getByRole('region', { name: 'Assistant policy summary' })).toHaveTextContent('The configured assistant runtime is unavailable, so no request is sent to the provider.');
    expect(sendMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('message-input')).toHaveValue('Keep this until policy is ready');
  });

  it('blocks exhausted-account sends while keeping the local draft editable', async () => {
    usageApi.useAccountUsage.mockReturnValue({ state: { status: 'success', data: { availability: { status: 'exhausted', canSubmit: false, reason: 'The AI allowance is exhausted.' } } }, refresh: vi.fn() });
    renderComposer();
    const user = userEvent.setup();
    const input = screen.getByTestId('message-input');
    await user.type(input, 'Keep this draft');

    expect(screen.getByTestId('ai-run-submit')).toBeDisabled();
    expect(screen.getByTestId('account-usage-gate')).toHaveTextContent('The AI allowance is exhausted.');
    expect(screen.getByRole('link', { name: 'View usage' })).toHaveAttribute('href', '/usage');
    expect(input).toHaveValue('Keep this draft');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('retries a failed automatic submission with the same idempotency key and keeps the draft', async () => {
    sendMock.mockRejectedValueOnce(new Error('Network failed'));
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('message-input'), 'My draft');
    const submit = screen.getByTestId('ai-run-submit');
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(await screen.findByTestId('chat-send-error')).toHaveTextContent('Keep your draft');
    expect(screen.getByTestId('message-input')).toHaveValue('My draft');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(sendMock.mock.calls[0]?.[4]).toBe(sendMock.mock.calls[1]?.[4]);
    expect(decideMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('requires explicit duplicate-work confirmation before starting a separate uncertain run', async () => {
    sendMock.mockResolvedValueOnce({ ...autoStarted, status: 'review_required', providerTransmission: 'unknown' });
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('message-input'), 'Review the workspace safely');
    await user.click(screen.getByTestId('ai-run-submit'));

    const separate = await screen.findByTestId('ai-run-separate-request');
    await user.click(separate);
    expect(await screen.findByTestId('ai-run-duplicate-work-warning')).toHaveTextContent('may repeat provider work');
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('provider-consent-alert-dialog')).not.toBeInTheDocument();
    expect(decideMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Keep current run' }));
    await user.click(screen.getByTestId('ai-run-separate-request'));
    await user.click(screen.getByTestId('ai-run-separate-confirm'));
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(sendMock.mock.calls[1]?.[2]).toBe('Review the workspace safely');
    expect(sendMock.mock.calls[1]?.[4]).not.toBe(sendMock.mock.calls[0]?.[4]);
    expect(decideMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('shows legacy pending runs as blocked and permits only explicit cancellation', async () => {
    getRunMock.mockResolvedValue(pending);
    renderComposer(false, `/conversation?runId=${RUN_ID}`);
    expect(await screen.findByTestId('ai-run-legacy-pending')).toBeVisible();
    expect(screen.queryByTestId('provider-consent-alert-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-run-legacy-refresh')).toBeEnabled();
    expect(screen.getByTestId('ai-run-submit')).toBeDisabled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(decideMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByTestId('ai-run-legacy-cancel'));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith(RUN_ID, 'csrf', expect.any(String)));
    expect(decideMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('sends with Ctrl+Enter', async () => {
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('message-input'), 'Keyboard request');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('provider-consent-alert-dialog')).not.toBeInTheDocument();
  });

  it('keeps archived chats read-only', () => {
    renderComposer(true);
    expect(screen.getByTestId('message-input')).toBeDisabled();
    expect(screen.getByTestId('ai-run-submit')).toBeDisabled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
