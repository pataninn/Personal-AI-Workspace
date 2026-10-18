import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userSessionReducer } from '@/entities/user-session';
import type { AiRunIntent, AiRunSnapshot, EgressManifest } from '@/entities/ai-run';
import type { ConversationHistoryResponse } from '@/entities/conversation';
import { ChatComposer } from '@/features/ai-run/ui/ChatComposer';

const { sendMock, getRunMock, getManifestMock, decideMock, startMock, listPermissionsMock, getHistoryMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getRunMock: vi.fn(),
  getManifestMock: vi.fn(),
  decideMock: vi.fn(),
  startMock: vi.fn(),
  listPermissionsMock: vi.fn(),
  getHistoryMock: vi.fn()
}));

vi.mock('@/entities/ai-run', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/ai-run')>(),
  sendChatMessage: sendMock,
  getAiRun: getRunMock,
  getEgressManifest: getManifestMock,
  decideEgress: decideMock,
  startAiRun: startMock,
  listProviderPermissions: listPermissionsMock
}));
vi.mock('@/entities/conversation', async (importOriginal) => ({ ...await importOriginal<typeof import('@/entities/conversation')>(), getConversation: getHistoryMock }));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '44444444-4444-4444-8444-000000000001';
const RUN_ID = '77777777-7777-4777-8777-000000000001';
const HASH = 'a'.repeat(64);
const manifest: EgressManifest = {
  runId: RUN_ID, manifestHash: HASH, status: 'pending_approval', provider: 'NVIDIA hosted NIM',
  providerProfile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b', categories: ['Request', 'Project facts'],
  relativePaths: [], itemCount: 1, messageCount: 0,
  facts: [{ id: 'fact-1', title: 'Private note', content: 'SYNTHETIC_PRIVATE_FACT_VALUE', source: { kind: 'user', label: 'Added by you', reference: null }, version: 1, verifiedAt: null, verificationStatus: 'verified', sizeBytes: 28, sourceHash: HASH }],
  byteEstimate: 64, tokenEstimate: 16, excludedItemCount: 0, omittedItemCount: 0, omissionSummary: 'No items were excluded.',
  bestEffortSecretDetection: true, preConsentNotice: 'Nothing has been sent to NVIDIA hosted NIM yet.'
};
const pending: AiRunSnapshot = {
  runId: RUN_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, status: 'pending_approval', phase: 'decision',
  decision: 'pending', manifestHash: HASH, safeMessage: 'Review the provider disclosure before continuing.', cleanup: 'not_started',
  providerTransmission: 'not_started', stagingItemCount: 0
};
const ready: AiRunSnapshot = { ...pending, status: 'ready', phase: 'runtime', decision: 'approved', providerApprovalMode: 'one_time' };
const queued: AiRunSnapshot = { ...ready, status: 'queued', phase: 'inference', safeMessage: 'Assistant run is queued.' };
const pendingIntent: AiRunIntent = { ...pending, manifest };
const history: ConversationHistoryResponse = {
  conversation: { id: CONVERSATION_ID, projectId: PROJECT_ID, title: 'Current conversation', status: 'active', lastActivityAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
  messages: [], nextBeforeSequence: null
};

function renderComposer(disabled = false, initialEntry = '/conversation', initialHistory: ConversationHistoryResponse | null = null): ReturnType<typeof vi.fn> {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: {
    status: 'authenticated' as const, principal: { id: 'owner', displayName: 'User', accountKind: 'regular' as const, role: 'user' as const }, csrfToken: 'csrf', expiresAt: null, errorCode: null
  } } });
  const onHistory = vi.fn();
  render(<Provider store={store}><MemoryRouter initialEntries={[initialEntry]}><ChatComposer projectId={PROJECT_ID} conversationId={CONVERSATION_ID} history={initialHistory} disabled={disabled} onConversationReconciled={onHistory} /></MemoryRouter></Provider>);
  return onHistory;
}

describe('ChatComposer', () => {
  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue(pendingIntent);
    getRunMock.mockReset().mockResolvedValue(queued);
    getManifestMock.mockReset().mockResolvedValue(manifest);
    decideMock.mockReset().mockResolvedValue(ready);
    startMock.mockReset().mockResolvedValue(queued);
    listPermissionsMock.mockReset().mockResolvedValue([]);
    getHistoryMock.mockReset().mockResolvedValue(history);
  });

  it('saves a pending message but waits for explicit consent before deciding or starting', async () => {
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('message-input'), 'Continue our earlier chat');
    const submit = screen.getByTestId('ai-run-submit');
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    const consent = await screen.findByTestId('provider-consent-alert-dialog');
    expect(sendMock).toHaveBeenCalledWith(PROJECT_ID, CONVERSATION_ID, 'Continue our earlier chat', 'csrf', expect.any(String));
    expect(screen.getByTestId('message-input')).toHaveValue('Continue our earlier chat');
    expect(consent).toHaveTextContent('Nothing has been sent to NVIDIA hosted NIM yet.');
    expect(screen.queryByText('SYNTHETIC_PRIVATE_FACT_VALUE')).not.toBeInTheDocument();
    expect(decideMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('keeps a rejected request local and retains its draft', async () => {
    decideMock.mockResolvedValue({ ...pending, status: 'rejected', decision: 'rejected', safeMessage: 'This run was not started.' });
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('message-input'), 'Do not send without approval');
    const submit = screen.getByTestId('ai-run-submit');
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await screen.findByTestId('provider-consent-alert-dialog');
    expect(startMock).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('provider-consent-reject'));

    await waitFor(() => expect(decideMock).toHaveBeenCalledWith(RUN_ID, { manifestHash: HASH, decision: 'reject' }, 'csrf', expect.any(String)));
    expect(startMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('message-input')).toHaveValue('Do not send without approval');
    expect(await screen.findByTestId('run-rejected')).toHaveTextContent('This run was not started');
  });

  it('starts only after approval and clears the matching saved draft', async () => {
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('message-input'), 'Approved request');
    const submit = screen.getByTestId('ai-run-submit');
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await screen.findByTestId('provider-consent-alert-dialog');
    expect(startMock).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('provider-consent-approve'));

    await waitFor(() => expect(decideMock).toHaveBeenCalledWith(RUN_ID, { manifestHash: HASH, decision: 'approve' }, 'csrf', expect.any(String)));
    await waitFor(() => expect(startMock).toHaveBeenCalledWith(RUN_ID, 'csrf', expect.any(String)));
    expect(screen.getByTestId('message-input')).toHaveValue('');
  });

  it('locks a new send when a decision is uncertain until the saved status is refreshed', async () => {
    decideMock.mockRejectedValueOnce(new Error('Connection lost'));
    getRunMock.mockResolvedValue(pending);
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('message-input'), 'Check decision state');
    const submit = screen.getByTestId('ai-run-submit');
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await screen.findByTestId('provider-consent-alert-dialog');
    await user.click(screen.getByTestId('provider-consent-approve'));

    const refresh = await screen.findByTestId('provider-consent-refresh');
    expect(await screen.findByTestId('provider-consent-error')).toHaveTextContent('could not be confirmed');
    expect(screen.getByTestId('provider-consent-approve')).toBeDisabled();
    expect(startMock).not.toHaveBeenCalled();
    getRunMock.mockResolvedValue(pending);
    await user.click(refresh);
    await waitFor(() => expect(getManifestMock).toHaveBeenCalledWith(RUN_ID));
    expect(screen.getByTestId('provider-consent-approve')).toBeEnabled();
    expect(screen.getByTestId('message-input')).toHaveValue('Check decision state');
  });

  it('retries a failed send with the same idempotency key and keeps the draft', async () => {
    sendMock.mockRejectedValueOnce(new Error('Network failed'));
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('message-input'), 'My draft');
    const submit = screen.getByTestId('ai-run-submit');
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent('Keep your draft');
    expect(screen.getByTestId('message-input')).toHaveValue('My draft');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    expect(sendMock.mock.calls[0]?.[4]).toBe(sendMock.mock.calls[1]?.[4]);
  });

  it('restores a pending run from the URL without resending or starting it', async () => {
    getRunMock.mockResolvedValue(pending);
    renderComposer(false, `/conversation?runId=${RUN_ID}`);
    expect(await screen.findByTestId('provider-consent-alert-dialog')).toBeVisible();
    expect(sendMock).not.toHaveBeenCalled();
    expect(getManifestMock).toHaveBeenCalledWith(RUN_ID);
    expect(decideMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('does not use a later history message to retry a restored unresolved run', async () => {
    getRunMock.mockResolvedValue({ ...pending, status: 'review_required', phase: 'review', decision: 'approved', providerTransmission: 'unknown' });
    const historyWithLaterMessage: ConversationHistoryResponse = {
      ...history,
      messages: [
        { id: 'original-request', conversationId: CONVERSATION_ID, role: 'user', sequence: 1, content: 'Original request for this run', createdAt: '2026-10-01T00:00:00.000Z' },
        { id: 'later-request', conversationId: CONVERSATION_ID, role: 'user', sequence: 2, content: 'Unrelated newer request', createdAt: '2026-10-02T00:00:00.000Z' }
      ]
    };
    renderComposer(false, `/conversation?runId=${RUN_ID}`, historyWithLaterMessage);

    expect(await screen.findByTestId('ai-run-restored-request-unavailable')).toHaveTextContent('cannot be safely matched to its original request');
    expect(screen.getByTestId('ai-run-restored-request-refresh')).toBeEnabled();
    expect(screen.queryByTestId('ai-run-safe-retry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-run-separate-request')).not.toBeInTheDocument();
    expect(sendMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('sends with Ctrl+Enter', async () => {
    renderComposer();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('message-input'), 'Keyboard request');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('provider-consent-alert-dialog')).toBeVisible();
  });

  it('keeps archived chats read-only', () => {
    renderComposer(true);
    expect(screen.getByTestId('message-input')).toBeDisabled();
    expect(screen.getByTestId('ai-run-submit')).toBeDisabled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
