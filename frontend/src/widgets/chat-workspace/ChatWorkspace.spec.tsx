import { configureStore } from '@reduxjs/toolkit';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userSessionReducer } from '@/entities/user-session';
import type { ConversationHistoryResponse, ConversationSnapshot } from '@/entities/conversation';
import type { ProjectSnapshot } from '@/entities/project';
import { ApiClientError } from '@/shared/api';
import { ChatWorkspace } from '@/widgets/chat-workspace/ChatWorkspace';

const { listConversationsMock, getConversationMock, createConversationMock, createMessageMock } = vi.hoisted(() => ({
  listConversationsMock: vi.fn(),
  getConversationMock: vi.fn(),
  createConversationMock: vi.fn(),
  createMessageMock: vi.fn()
}));

vi.mock('@/entities/conversation/api/conversation-api', () => ({
  listConversations: listConversationsMock,
  getConversation: getConversationMock,
  createConversation: createConversationMock,
  createMessage: createMessageMock
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const FIRST_ID = '44444444-4444-4444-8444-000000000001';
const SECOND_ID = '44444444-4444-4444-8444-000000000002';

const activeProject: ProjectSnapshot = {
  id: PROJECT_ID,
  name: 'Workspace',
  slug: 'workspace',
  relativeRoot: 'apps',
  status: 'active',
  version: 1,
  createdAt: '2026-09-12T12:00:00.000Z',
  updatedAt: '2026-09-12T12:00:00.000Z'
};

const archivedProject: ProjectSnapshot = { ...activeProject, status: 'archived', version: 2 };

const firstConversation: ConversationSnapshot = {
  id: FIRST_ID,
  projectId: PROJECT_ID,
  title: 'First conversation',
  status: 'active',
  lastActivityAt: '2026-09-12T12:00:00.000Z',
  createdAt: '2026-09-12T12:00:00.000Z',
  updatedAt: '2026-09-12T12:00:00.000Z'
};

const secondConversation: ConversationSnapshot = { ...firstConversation, id: SECOND_ID, title: 'Second conversation' };

const history: ConversationHistoryResponse = {
  conversation: firstConversation,
  messages: [{ id: '55555555-5555-4555-8555-000000000001', conversationId: FIRST_ID, role: 'user', sequence: 1, content: 'Saved text', createdAt: '2026-09-12T12:00:00.000Z' }],
  nextBeforeSequence: null
};

const emptyHistory: ConversationHistoryResponse = { conversation: firstConversation, messages: [], nextBeforeSequence: null };

const session = {
  status: 'authenticated' as const,
  principal: { id: 'user-1', displayName: 'Local user' },
  csrfToken: 'csrf-token',
  expiresAt: '2026-09-13T00:00:00.000Z',
  errorCode: null
};

function renderWorkspace(project: ProjectSnapshot = activeProject, selectedId = FIRST_ID): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer }, preloadedState: { userSession: session } });
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/conversations/${selectedId}`]}>
        <Routes><Route path="/projects/:projectId/conversations/:conversationId?" element={<ChatWorkspace project={project} />} /></Routes>
      </MemoryRouter>
    </Provider>
  );
}

function listResponse(conversations: readonly ConversationSnapshot[] = [firstConversation]): { readonly conversations: readonly ConversationSnapshot[]; readonly nextCursor: null } {
  return { conversations, nextCursor: null };
}

describe('ChatWorkspace', () => {
  beforeEach(() => {
    listConversationsMock.mockReset();
    getConversationMock.mockReset();
    createConversationMock.mockReset();
    createMessageMock.mockReset();
  });

  it('renders readable loading states before list/history data arrives', async () => {
    let resolveList: (value: ReturnType<typeof listResponse>) => void = () => undefined;
    let resolveHistory: (value: ConversationHistoryResponse) => void = () => undefined;
    listConversationsMock.mockReturnValue(new Promise((resolve) => { resolveList = resolve; }));
    getConversationMock.mockReturnValue(new Promise((resolve) => { resolveHistory = resolve; }));
    renderWorkspace();

    expect(await screen.findByTestId('conversation-list-loading')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('conversation-list')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('conversation-list-status')).toHaveTextContent('Loading conversations');
    expect(screen.getByTestId('conversation-history-loading')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('conversation-history')).toHaveAttribute('aria-busy', 'true');
    resolveList(listResponse());
    resolveHistory(history);
    expect(await screen.findByTestId('conversation-history')).toBeInTheDocument();
  });

  it('lists server order, exposes selection links, and loads the selected history', async () => {
    listConversationsMock.mockResolvedValue(listResponse([firstConversation, secondConversation]));
    getConversationMock.mockImplementation((_: string, conversationId: string) => Promise.resolve({ ...history, conversation: conversationId === SECOND_ID ? secondConversation : firstConversation }));
    renderWorkspace();

    expect(await screen.findAllByTestId('conversation-item')).toHaveLength(2);
    expect(screen.getAllByTestId('conversation-item')[0]).toHaveTextContent('First conversation');
    expect(screen.getAllByTestId('conversation-item')[1]).toHaveTextContent('Second conversation');
    expect(screen.getByTestId('conversation-selected')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getAllByTestId('conversation-item')[1]);
    await waitFor(() => expect(getConversationMock).toHaveBeenCalledWith(PROJECT_ID, SECOND_ID));
    expect(await screen.findByRole('heading', { name: 'Second conversation' })).toHaveFocus();
  });

  it('shows the empty history state with an enabled composer', async () => {
    listConversationsMock.mockResolvedValue(listResponse());
    getConversationMock.mockResolvedValue(emptyHistory);
    renderWorkspace();

    expect(await screen.findByTestId('conversation-history-empty')).toHaveTextContent('Let’s get started');
    expect(screen.getByTestId('message-input')).toBeEnabled();
  });

  it('loads older history pages and reconciles them in ascending de-duplicated order', async () => {
    const baseMessage = history.messages[0];
    if (!baseMessage) {
      throw new Error('The history fixture needs a base message.');
    }
    const newestMessages = [
      { ...baseMessage, id: '55555555-5555-4555-8555-000000000003', sequence: 3, content: 'three' },
      { ...baseMessage, id: '55555555-5555-4555-8555-000000000004', sequence: 4, content: 'four' }
    ];
    const olderMessages = [
      { ...baseMessage, id: '55555555-5555-4555-8555-000000000001', sequence: 1, content: 'one' },
      { ...baseMessage, id: '55555555-5555-4555-8555-000000000002', sequence: 2, content: 'two' },
      newestMessages[0]
    ];
    listConversationsMock.mockResolvedValue(listResponse());
    getConversationMock.mockImplementation((_: string, __: string, beforeSequence?: number) => Promise.resolve(beforeSequence === undefined
      ? { ...history, messages: newestMessages, nextBeforeSequence: 3 }
      : { ...history, messages: olderMessages, nextBeforeSequence: null }));
    renderWorkspace();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('conversation-history-load-older'));
    await waitFor(() => expect(getConversationMock).toHaveBeenLastCalledWith(PROJECT_ID, FIRST_ID, 3));
    expect(await screen.findAllByTestId('message-item')).toHaveLength(4);
    expect(screen.getAllByTestId('message-content').map((node) => node.textContent)).toEqual(['one', 'two', 'three', 'four']);
    expect(screen.queryByTestId('conversation-history-load-older')).not.toBeInTheDocument();
  });

  it('uses retryable history copy for non-404 failures', async () => {
    listConversationsMock.mockResolvedValue(listResponse());
    getConversationMock.mockRejectedValueOnce(new ApiClientError(503, 'INTERNAL_ERROR', 'temporary failure')).mockResolvedValueOnce(emptyHistory);
    renderWorkspace();

    expect(await screen.findByTestId('conversation-history-retryable')).toHaveTextContent('Conversation history unavailable');
    expect(screen.queryByTestId('conversation-not-found')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('conversation-history-retry'));
    expect(await screen.findByTestId('conversation-history-empty')).toBeInTheDocument();
  });

  it('offers a list retry instead of presenting a false empty state', async () => {
    listConversationsMock.mockRejectedValueOnce(new ApiClientError(503, 'INTERNAL_ERROR', 'failed')).mockResolvedValueOnce(listResponse([]));
    getConversationMock.mockResolvedValue(emptyHistory);
    renderWorkspace();
    expect(await screen.findByTestId('conversation-list-error')).toHaveTextContent('could not be loaded');
    expect(screen.queryByTestId('conversation-list-empty')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('conversation-list-retry'));
    expect(await screen.findByTestId('conversation-list-empty')).toBeInTheDocument();
  });

  it('keeps a polite conversation-created announcement after the dialog closes', async () => {
    listConversationsMock.mockResolvedValue(listResponse([]));
    getConversationMock.mockResolvedValue(emptyHistory);
    createConversationMock.mockResolvedValue(firstConversation);
    renderWorkspace(activeProject, '');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Get started' })).toBeInTheDocument();
    expect(screen.queryByText('Choose a conversation')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('conversation-create-trigger')).toHaveLength(1);
    await user.click(await screen.findByTestId('conversation-create-trigger'));
    await user.type(screen.getByLabelText('Conversation name'), 'New saved thread');
    await user.click(screen.getByTestId('conversation-create-submit'));
    expect(await screen.findByTestId('conversation-create-success-announcement')).toHaveTextContent('Conversation created.');
    expect(screen.queryByTestId('conversation-create-dialog')).not.toBeInTheDocument();
  });

  it('opens creation from the rail and keeps archived workspaces read-only', async () => {
    listConversationsMock.mockResolvedValue(listResponse());
    getConversationMock.mockResolvedValue(emptyHistory);
    renderWorkspace();
    const user = userEvent.setup();
    await screen.findByTestId('conversation-create-trigger');
    await user.click(screen.getByTestId('conversation-create-trigger'));
    expect(await screen.findByTestId('conversation-create-dialog')).toBeInTheDocument();

    cleanup();
    listConversationsMock.mockResolvedValue(listResponse([firstConversation]));
    getConversationMock.mockResolvedValue(history);
    renderWorkspace(archivedProject);
    expect(await screen.findByTestId('conversation-project-context')).toHaveTextContent('read-only');
    expect(screen.getByTestId('conversation-create-trigger')).toBeDisabled();
    expect(screen.getByTestId('conversation-create-trigger')).toHaveAttribute('aria-describedby', 'project-archived-message');
    expect(await screen.findByTestId('message-input')).toBeDisabled();
    expect(screen.getByTestId('message-input')).toHaveAttribute('aria-describedby', expect.stringContaining('project-archived-message'));
    expect(screen.getByTestId('ai-run-submit')).toHaveAttribute('aria-describedby', 'project-archived-message');
    expect(screen.getAllByTestId('project-archived-message').length).toBeGreaterThan(0);
  });

  it('renders a generic not-found recovery surface without foreign details', async () => {
    listConversationsMock.mockResolvedValue(listResponse());
    getConversationMock.mockRejectedValue(new ApiClientError(404, 'CONVERSATION_NOT_FOUND', 'secret title')); 
    renderWorkspace();
    expect(await screen.findByTestId('conversation-not-found')).toHaveTextContent('Conversation not found');
    expect(screen.queryByText('secret title')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversation-back-to-project')).toBeInTheDocument();
  });
});
