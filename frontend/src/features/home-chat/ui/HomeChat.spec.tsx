import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userSessionReducer } from '@/entities/user-session';
import type { HomeConversationEvent, HomeConversationScope, HomeConversationSnapshot, HomeTurnSnapshot, HomeTurnSubmission } from '@/entities/home-conversation';
import { HomeChat } from '@/features/home-chat/ui/HomeChat';
import { useHomeChat } from '@/features/home-chat/model/use-home-chat';
import { ApiClientError } from '@/shared/api';

const api = vi.hoisted(() => ({
  cancelHomeTurn: vi.fn(),
  createHomeConversation: vi.fn(),
  getHomeConversation: vi.fn(),
  getHomeTurn: vi.fn(),
  acceptHomeProposal: vi.fn(),
  cancelHomeProposal: vi.fn(),
  editHomeProposalItem: vi.fn(),
  getHomeProposal: vi.fn(),
  listHomeProposals: vi.fn(),
  removeHomeProposalItem: vi.fn(),
  resumeHomeProposal: vi.fn(),
  listHomeConversations: vi.fn(),
  listHomeEvents: vi.fn(),
  listHomeMessages: vi.fn(),
  listHomeTurns: vi.fn(),
  submitHomeTurn: vi.fn()
}));
const policyApi = vi.hoisted(() => ({ getAssistantExecutionPolicy: vi.fn() }));

vi.mock('@/entities/home-conversation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/home-conversation')>(),
  ...api
}));
vi.mock('@/entities/assistant-policy', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/assistant-policy')>(),
  ...policyApi
}));

const HOME_SCOPE: HomeConversationScope = { kind: 'home' };
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';
const TURN_ID = '33333333-3333-4333-8333-333333333333';
const DISCLOSURE_ID = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-16T00:00:00.000Z';

const conversation: HomeConversationSnapshot = {
  id: CONVERSATION_ID, scope: HOME_SCOPE, title: 'Planning question', lastEventSequence: 0,
  lastActivityAt: NOW, createdAt: NOW, updatedAt: NOW
};
const secondConversation: HomeConversationSnapshot = {
  ...conversation, id: SECOND_CONVERSATION_ID, title: 'Another saved conversation'
};

const pendingTurn: HomeTurnSnapshot = {
  id: TURN_ID, conversationId: CONVERSATION_ID, sequence: 1, status: 'pending', createdAt: NOW, updatedAt: NOW
};

function consentEvent(sequence = 1, turnId = TURN_ID, entityId = DISCLOSURE_ID): HomeConversationEvent {
  return {
    sequence,
    type: 'consent.requested',
    turnId,
    entityId,
    payload: { phase: 'initial', providerProfile: 'nvidia-hosted-nim', model: 'test-model', scopeKind: 'home', scopeId: null, categories: ['current_message'], itemCount: 1, byteLimit: 1024 },
    createdAt: NOW
  };
}

function consentDecisionEvent(sequence: number, turnId: string, entityId: string, decision: 'allow' | 'deny'): HomeConversationEvent {
  return { sequence, type: 'consent.decided', turnId, entityId, payload: { decision }, createdAt: NOW };
}

function submission(content: string, status: HomeTurnSnapshot['status'] = 'running') {
  return {
    turn: { ...pendingTurn, status },
    message: { id: 'message-1', turnId: TURN_ID, sequence: 1, role: 'user' as const, content, createdAt: NOW },
    execution: { state: status === 'unknown' ? 'unknown' as const : 'running' as const },
    replayed: false
  };
}

function policyFor(scope: 'home' | 'workspace') {
  return {
    scope: { kind: scope, label: scope === 'home' ? 'Home' : 'Planning workspace' },
    policy: {
      enabled: true,
      revision: '1',
      provider: { name: 'NVIDIA hosted NIM', model: 'test-model' },
      included: { categories: ['current_message'], items: [] },
      exclusionsEnforced: true,
      capabilities: scope === 'home' ? ['home_task_read', 'home_action_undo'] : ['workspace_file_read']
    },
    fileAccess: false,
    readiness: { state: 'ready' }
  };
}

function renderChat(entry = '/dashboard', scope = HOME_SCOPE, disabled = false): void {
  const store = configureStore({
    reducer: { userSession: userSessionReducer },
    preloadedState: { userSession: { status: 'authenticated' as const, principal: { id: 'owner', displayName: 'User', accountKind: 'regular' as const, role: 'user' as const }, csrfToken: 'csrf', expiresAt: null, errorCode: null } }
  });
  render(<Provider store={store}><MemoryRouter initialEntries={[entry]}><HomeChat scope={scope} scopeLabel={scope.kind === 'home' ? 'Home' : 'Planning workspace'} disabled={disabled} disabledReason={disabled ? 'This planning workspace is archived. Existing conversation history is read-only.' : undefined} /></MemoryRouter></Provider>);
}

function ConversationSwitchHarness(): React.JSX.Element {
  const navigate = useNavigate();
  return <>
    <button type="button" onClick={() => navigate(`/dashboard?conversation=${SECOND_CONVERSATION_ID}`)}>Switch conversation</button>
    <HomeChat scope={HOME_SCOPE} scopeLabel="Home" />
  </>;
}

function renderSwitchChat(): void {
  const store = configureStore({
    reducer: { userSession: userSessionReducer },
    preloadedState: { userSession: { status: 'authenticated' as const, principal: { id: 'owner', displayName: 'User', accountKind: 'regular' as const, role: 'user' as const }, csrfToken: 'csrf', expiresAt: null, errorCode: null } }
  });
  render(<Provider store={store}><MemoryRouter initialEntries={[`/dashboard?conversation=${CONVERSATION_ID}`]}><ConversationSwitchHarness /></MemoryRouter></Provider>);
}

function HookProbe({ scope }: { readonly scope: HomeConversationScope }): React.JSX.Element {
  const chat = useHomeChat({ scope });
  return <output data-testid="event-state">{`${chat.lastProcessedEventSequence}:${chat.events.map((event) => event.type).join(',')}`}</output>;
}

function renderProbe(entry: string, scope = HOME_SCOPE): void {
  const store = configureStore({
    reducer: { userSession: userSessionReducer },
    preloadedState: { userSession: { status: 'authenticated' as const, principal: { id: 'owner', displayName: 'User', accountKind: 'regular' as const, role: 'user' as const }, csrfToken: 'csrf', expiresAt: null, errorCode: null } }
  });
  render(<Provider store={store}><MemoryRouter initialEntries={[entry]}><HookProbe scope={scope} /></MemoryRouter></Provider>);
}

beforeEach(() => {
  window.sessionStorage.clear();
  api.cancelHomeTurn.mockReset().mockResolvedValue({ turn: { ...pendingTurn, status: 'cancel_requested' }, replayed: false });
  api.createHomeConversation.mockReset().mockResolvedValue({ ...conversation, replayed: false });
  api.getHomeConversation.mockReset().mockResolvedValue(conversation);
  api.getHomeTurn.mockReset().mockImplementation(async (_conversationId: string, turnId: string) => ({ ...pendingTurn, id: turnId, status: 'running' }));
  api.listHomeProposals.mockReset().mockResolvedValue({ proposals: [], nextCursor: null });
  api.getHomeProposal.mockReset();
  api.listHomeConversations.mockReset().mockResolvedValue({ conversations: [], nextCursor: null });
  api.listHomeEvents.mockReset().mockResolvedValue({ events: [], nextAfterSequence: null, lastEventSequence: 0 });
  api.listHomeMessages.mockReset().mockResolvedValue({ messages: [], nextBeforeSequence: null });
  api.listHomeTurns.mockReset().mockResolvedValue({ turns: [], nextAfterSequence: null });
  api.submitHomeTurn.mockReset().mockResolvedValue(submission('Plan a trip'));
  policyApi.getAssistantExecutionPolicy.mockReset().mockImplementation(async (query: { readonly scope: 'home' | 'workspace' }) => policyFor(query.scope));
});

describe('Home chat', () => {
  it('keeps a draft and its idempotency key while policy refresh is required after an unavailable response', async () => {
    policyApi.getAssistantExecutionPolicy.mockImplementationOnce(async () => policyFor('home'))
      .mockImplementationOnce(async () => ({ ...policyFor('home'), readiness: { state: 'unavailable', reasonCode: 'runtime_unverified' } }))
      .mockImplementationOnce(async () => policyFor('home'));
    api.listHomeConversations.mockResolvedValue({ conversations: [conversation], nextCursor: null });
    api.submitHomeTurn.mockRejectedValueOnce(new ApiClientError(503, 'ASSISTANT_EXECUTION_UNAVAILABLE', 'Unavailable', []));
    api.submitHomeTurn.mockResolvedValueOnce(submission('Keep this request while availability changes.'));
    renderChat(`/dashboard?conversation=${CONVERSATION_ID}`);
    const user = userEvent.setup();
    const input = await screen.findByRole('textbox', { name: 'Message the assistant' });
    await screen.findByText('Assistant is available.');
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, 'Keep this request while availability changes.');
    await user.click(await screen.findByRole('button', { name: 'Send' }));

    await screen.findByTestId('home-chat-policy-unavailable');
    expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toHaveValue('Keep this request while availability changes.');
    expect(screen.getByRole('button', { name: 'Retry same send' })).toBeDisabled();
    expect(api.submitHomeTurn).toHaveBeenCalledTimes(1);
    const originalKey = api.submitHomeTurn.mock.calls[0]?.[3];

    await user.click(screen.getByRole('button', { name: 'Refresh availability' }));
    await screen.findByText('Assistant is available.');
    await user.click(await screen.findByRole('button', { name: 'Retry same send' }));

    await waitFor(() => expect(api.submitHomeTurn).toHaveBeenCalledTimes(2));
    expect(api.submitHomeTurn.mock.calls[1]?.[3]).toBe(originalKey);
    expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toHaveValue('');
  });

  it('creates on the first send and starts the automatic path without a consent decision', async () => {
    api.listHomeMessages.mockImplementation(async () => {
      const submittedContent = api.submitHomeTurn.mock.calls[0]?.[1];
      return {
        messages: typeof submittedContent === 'string'
          ? [{ id: 'message-1', turnId: TURN_ID, sequence: 1, role: 'user', content: submittedContent, createdAt: NOW }]
          : [],
        nextBeforeSequence: null
      };
    });
    renderChat();
    const user = userEvent.setup();
    await screen.findByTestId('home-chat-empty');
    await screen.findByText('Assistant is available.');
    const policySummary = screen.getByRole('region', { name: 'Assistant policy summary' });
    expect(policySummary).toHaveTextContent('Workspace data is stored on the operator-managed deployment.');
    expect(policySummary).toHaveTextContent('When you submit an assistant request, selected context is sent to NVIDIA hosted NIM for processing.');
    expect(within(policySummary).getByRole('link', { name: 'Read NVIDIA API Trial Terms' })).toHaveAttribute('href', 'https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf');
    expect(within(policySummary).queryByRole('button', { name: /approve|accept/u })).not.toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Message the assistant' });
    await user.type(input, 'Plan a trip');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.submitHomeTurn).toHaveBeenCalledTimes(1));
    expect(api.createHomeConversation).toHaveBeenCalledWith(HOME_SCOPE, 'Plan a trip', 'csrf', expect.any(String));
    expect(api.submitHomeTurn).toHaveBeenCalledWith(CONVERSATION_ID, 'Plan a trip', 'csrf', expect.any(String));
    expect(api.createHomeConversation.mock.calls[0]?.[3]).not.toBe(api.submitHomeTurn.mock.calls[0]?.[3]);
    await waitFor(() => expect(screen.getByTestId('home-chat-input')).toHaveValue(''));
    expect(screen.getByText('NVIDIA hosted NIM · test-model')).toBeInTheDocument();
    expect(policyApi.getAssistantExecutionPolicy).toHaveBeenCalledWith({ scope: 'home' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.submitHomeTurn.mock.calls[0]?.[3]).toEqual(expect.any(String));
  });

  it('retries an uncertain conversation creation with the same key and does not submit automatically', async () => {
    api.createHomeConversation.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({ ...conversation, replayed: true });
    renderChat();
    const user = userEvent.setup();
    await screen.findByTestId('home-chat-empty');
    await user.type(screen.getByRole('textbox', { name: 'Message the assistant' }), 'A question to keep');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(await screen.findByRole('button', { name: 'Retry conversation creation' }));

    await waitFor(() => expect(api.createHomeConversation).toHaveBeenCalledTimes(2));
    expect(api.createHomeConversation.mock.calls[0]?.[3]).toBe(api.createHomeConversation.mock.calls[1]?.[3]);
    expect(api.submitHomeTurn).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toHaveValue('A question to keep');
  });

  it('uses native history links for saved conversation navigation', async () => {
    api.listHomeConversations.mockResolvedValue({ conversations: [conversation, secondConversation], nextCursor: null });
    renderChat(`/dashboard?conversation=${CONVERSATION_ID}`);
    const links = await screen.findAllByRole('link', { name: /Another saved conversation/u });

    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute('href', `/dashboard?conversation=${SECOND_CONVERSATION_ID}`);
  });

  it('blocks legacy consent turns without polling or presenting a decision control', async () => {
    api.listHomeConversations.mockResolvedValue({ conversations: [conversation], nextCursor: null });
    api.listHomeTurns.mockResolvedValue({ turns: [{ ...pendingTurn, status: 'running' }], nextAfterSequence: null });
    api.listHomeEvents.mockResolvedValue({
      events: [consentEvent(1), consentDecisionEvent(2, TURN_ID, DISCLOSURE_ID, 'allow')],
      nextAfterSequence: null, lastEventSequence: 2
    });
    renderChat(`/dashboard?conversation=${CONVERSATION_ID}`);

    expect(await screen.findByTestId('home-chat-legacy-blocked')).toHaveTextContent('This saved action cannot be resumed.');
    expect(screen.getByTestId('home-chat-legacy-blocked')).toHaveTextContent('This saved action cannot be resumed.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /allow this turn|keep private|share and continue/iu })).not.toBeInTheDocument();
    expect(api.getHomeTurn).not.toHaveBeenCalled();
    expect(api.cancelHomeTurn).not.toHaveBeenCalled();
  });

  it('reconciles before offering an explicit same-key retry after an uncertain submit', async () => {
    api.listHomeConversations.mockResolvedValue({ conversations: [conversation], nextCursor: null });
    api.submitHomeTurn.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({
      ...submission('My question', 'unknown'), execution: { state: 'unknown' }, replayed: true
    });
    renderChat(`/dashboard?conversation=${CONVERSATION_ID}`);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toBeEnabled());
    await user.type(screen.getByRole('textbox', { name: 'Message the assistant' }), 'My question');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('button', { name: 'Retry same send' })).toBeInTheDocument();
    expect(api.submitHomeTurn).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Retry same send' }));
    await waitFor(() => expect(api.submitHomeTurn).toHaveBeenCalledTimes(2));
    expect(api.submitHomeTurn.mock.calls[0]?.[3]).toBe(api.submitHomeTurn.mock.calls[1]?.[3]);
    expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toHaveValue('My question');
    expect(await screen.findByText('Needs review')).toBeInTheDocument();
  });

  it('ignores a late submission response after switching conversations', async () => {
    const savedMessage = { id: 'message-2', turnId: TURN_ID, sequence: 1, role: 'user' as const, content: 'Saved second message', createdAt: NOW };
    let resolveSubmit: ((value: HomeTurnSubmission) => void) | undefined;
    api.listHomeConversations.mockResolvedValue({ conversations: [conversation, secondConversation], nextCursor: null });
    api.getHomeConversation.mockImplementation(async (id: string) => id === SECOND_CONVERSATION_ID ? secondConversation : conversation);
    api.listHomeMessages.mockImplementation(async (id: string) => ({ messages: id === SECOND_CONVERSATION_ID ? [savedMessage] : [], nextBeforeSequence: null }));
    api.submitHomeTurn.mockImplementation(() => new Promise((resolve) => { resolveSubmit = resolve; }));
    renderSwitchChat();
    const user = userEvent.setup();
    const input = await screen.findByRole('textbox', { name: 'Message the assistant' });
    await user.type(input, 'Late response');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.submitHomeTurn).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Switch conversation' }));
    expect(await screen.findByText('Saved second message')).toBeInTheDocument();
    resolveSubmit?.({
      ...submission('Late response', 'running'),
      turn: { ...pendingTurn, status: 'running' },
      execution: { state: 'running' }
    });

    await waitFor(() => expect(screen.getByText('Saved second message')).toBeInTheDocument());
    expect(screen.getByTestId('home-chat-messages')).not.toHaveTextContent('Late response');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('replays every event page in sequence and retains non-chat events for later hydration', async () => {
    api.listHomeConversations.mockResolvedValue({ conversations: [conversation], nextCursor: null });
    api.listHomeEvents.mockImplementation(async (_id: string, after: number) => after === 0
      ? { events: [consentEvent()], nextAfterSequence: 1, lastEventSequence: 2 }
      : { events: [{ sequence: 2, type: 'action.receipt', turnId: TURN_ID, entityId: 'receipt-1', payload: { status: 'applied' }, createdAt: NOW }], nextAfterSequence: null, lastEventSequence: 2 });
    renderProbe(`/dashboard?conversation=${CONVERSATION_ID}`);

    expect(await screen.findByTestId('event-state')).toHaveTextContent('2:consent.requested,action.receipt');
    expect(api.listHomeEvents.mock.calls.map((call) => call[1])).toContain(0);
    expect(api.listHomeEvents.mock.calls.map((call) => call[1])).toContain(1);
  });

  it('keeps a stop request pending until a read-only status check confirms cancellation', async () => {
    const savedMessage = { id: 'message-1', turnId: TURN_ID, sequence: 1, role: 'user' as const, content: 'Keep this reply short.', createdAt: NOW };
    api.listHomeConversations.mockResolvedValue({ conversations: [conversation], nextCursor: null });
    api.listHomeMessages.mockResolvedValue({ messages: [savedMessage], nextBeforeSequence: null });
    api.listHomeTurns.mockResolvedValue({ turns: [{ ...pendingTurn, status: 'running' }], nextAfterSequence: null });
    api.getHomeTurn.mockResolvedValue({ ...pendingTurn, status: 'cancelled' });
    renderChat(`/dashboard?conversation=${CONVERSATION_ID}`);
    const user = userEvent.setup();
    const stop = await screen.findByRole('button', { name: 'Stop response' });

    await user.click(stop);
    expect(await screen.findAllByText('Stopping…')).toHaveLength(2);
    expect(await screen.findByRole('button', { name: 'Check status' })).toBeEnabled();
    expect(api.cancelHomeTurn).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Check status' }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(api.getHomeTurn).toHaveBeenCalledWith(CONVERSATION_ID, TURN_ID);
    expect(api.cancelHomeTurn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Stop response' })).not.toBeInTheDocument();
  });

  it('checks status after a failed stop request before allowing another cancellation attempt', async () => {
    const savedMessage = { id: 'message-1', turnId: TURN_ID, sequence: 1, role: 'user' as const, content: 'Keep this reply short.', createdAt: NOW };
    api.listHomeConversations.mockResolvedValue({ conversations: [conversation], nextCursor: null });
    api.listHomeMessages.mockResolvedValue({ messages: [savedMessage], nextBeforeSequence: null });
    api.listHomeTurns.mockResolvedValue({ turns: [{ ...pendingTurn, status: 'running' }], nextAfterSequence: null });
    api.cancelHomeTurn.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({ turn: { ...pendingTurn, status: 'cancel_requested' }, replayed: false });
    api.getHomeTurn.mockResolvedValue({ ...pendingTurn, status: 'running' });
    renderChat(`/dashboard?conversation=${CONVERSATION_ID}`);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Stop response' }));
    await screen.findByText('The stop request could not be confirmed. Check status before trying again.');
    const checkStatus = await screen.findByRole('button', { name: 'Check status' });
    expect(checkStatus).toBeEnabled();
    expect(api.cancelHomeTurn).toHaveBeenCalledTimes(1);

    await user.click(checkStatus);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop response' })).toBeEnabled());
    expect(api.getHomeTurn).toHaveBeenCalledWith(CONVERSATION_ID, TURN_ID);
    expect(api.cancelHomeTurn).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Stop response' }));
    await screen.findByRole('button', { name: 'Check status' });
    expect(api.cancelHomeTurn).toHaveBeenCalledTimes(2);
  });

  it('keeps archived planning chat readable and disables all write controls', async () => {
    const workspaceConversation: HomeConversationSnapshot = { ...conversation, scope: { kind: 'workspace', workspaceId: WORKSPACE_ID } };
    api.listHomeConversations.mockResolvedValue({ conversations: [workspaceConversation], nextCursor: null });
    api.getHomeConversation.mockResolvedValue(workspaceConversation);
    renderChat(`/projects/${WORKSPACE_ID}/planning-chat?conversation=${CONVERSATION_ID}`, { kind: 'workspace', workspaceId: WORKSPACE_ID }, true);
    await screen.findByTestId('planning-chat-read-only');
    expect(screen.getByText('Planning chat for this workspace.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(api.createHomeConversation).not.toHaveBeenCalled();
  });
});
