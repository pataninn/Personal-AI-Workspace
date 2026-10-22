import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiRunIntent, EgressManifest } from '@/entities/ai-run';
import type { ConversationHistoryResponse } from '@/entities/conversation';
import { useDirectChat } from '@/features/ai-run/model/use-direct-chat';

const { sendMock, getRunMock, getManifestMock, getHistoryMock } = vi.hoisted(() => ({
  sendMock: vi.fn(), getRunMock: vi.fn(), getManifestMock: vi.fn(), getHistoryMock: vi.fn()
}));

vi.mock('@/entities/ai-run', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/ai-run')>(),
  sendChatMessage: sendMock, getAiRun: getRunMock, getEgressManifest: getManifestMock
}));
vi.mock('@/entities/conversation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/conversation')>(), getConversation: getHistoryMock
}));

const manifest: EgressManifest = {
  runId: 'run-1', manifestHash: 'a'.repeat(64), status: 'pending_approval', provider: 'Nebius Token Factory',
  providerProfile: 'nebius-token-factory', model: 'nemotron', categories: ['Request'], relativePaths: [],
  itemCount: 0, messageCount: 0, facts: [], byteEstimate: 16, tokenEstimate: 4, excludedItemCount: 0,
  omittedItemCount: 0, omissionSummary: '', bestEffortSecretDetection: true, preConsentNotice: 'Nothing sent.'
};
const pending: AiRunIntent = {
  runId: 'run-1', projectId: 'project-1', conversationId: 'conversation-1', status: 'pending_approval',
  phase: 'decision', decision: 'pending', manifestHash: manifest.manifestHash, safeMessage: 'Review request.',
  cleanup: 'not_started', providerTransmission: 'not_started', stagingItemCount: 0, manifest
};
const history: ConversationHistoryResponse = {
  conversation: { id: 'conversation-1', projectId: 'project-1', title: 'Chat', status: 'active',
    lastActivityAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
  messages: [], nextBeforeSequence: null
};

function renderChat() {
  const onHistory = vi.fn();
  const hook = renderHook(() => ({
    chat: useDirectChat({ projectId: 'project-1', conversationId: 'conversation-1', csrfToken: 'csrf',
      disabled: false, permissionListReady: true, onHistory }),
    navigate: useNavigate()
  }), { wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter> });
  return { ...hook, onHistory };
}

describe('useDirectChat recovery', () => {
  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue(pending);
    getRunMock.mockReset().mockResolvedValue(pending);
    getManifestMock.mockReset().mockResolvedValue(manifest);
    getHistoryMock.mockReset().mockResolvedValue(history);
  });

  it('reloads conversation history and clears its error when status refresh succeeds', async () => {
    getHistoryMock.mockRejectedValueOnce(new Error('History unavailable'));
    const { result, onHistory } = renderChat();
    act(() => result.current.chat.setContent('Saved request'));
    await act(async () => { await result.current.chat.send(); });
    expect(result.current.chat.error).toContain('conversation history could not be refreshed');

    await act(async () => { await result.current.chat.refreshStatus(); });

    expect(onHistory).toHaveBeenCalledWith(history);
    expect(result.current.chat.error).toBeNull();
    expect(result.current.chat.errorAction).toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('reports a failed status refresh and clears the error after a successful retry', async () => {
    const { result } = renderChat();
    act(() => result.current.chat.setContent('Saved request'));
    await act(async () => { await result.current.chat.send(); });
    getRunMock.mockRejectedValueOnce(new Error('Status unavailable'));

    await act(async () => { await result.current.chat.refreshStatus(); });

    expect(result.current.chat.error).toContain('could not be loaded');
    expect(result.current.chat.errorAction).toBe('refresh-run');
    await act(async () => { await result.current.chat.refreshStatus(); });
    expect(result.current.chat.error).toBeNull();
  });

  it('blocks sends and refreshes the requested URL when restoring another run fails', async () => {
    sendMock.mockResolvedValue({ ...pending, status: 'succeeded', decision: 'approved' });
    const { result } = renderChat();
    act(() => result.current.chat.setContent('Completed request'));
    await act(async () => { await result.current.chat.send(); });
    getRunMock.mockRejectedValue(new Error('Unknown run'));

    act(() => { result.current.navigate('?runId=unavailable-run'); });
    await waitFor(() => expect(result.current.chat.error).toContain('could not be loaded'));

    expect(result.current.chat.run).toBeNull();
    expect(result.current.chat.manifest).toBeNull();
    expect(result.current.chat.busy).toBe(true);
    act(() => result.current.chat.setContent('Another request'));
    await act(async () => { await result.current.chat.send(); });
    expect(sendMock).toHaveBeenCalledTimes(1);
    getRunMock.mockClear();
    await act(async () => { await result.current.chat.refreshStatus(); });
    await waitFor(() => expect(getRunMock).toHaveBeenCalledWith('unavailable-run'));
  });
});
