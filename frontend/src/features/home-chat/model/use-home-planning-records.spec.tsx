import { configureStore } from '@reduxjs/toolkit';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeConversationEvent, HomeProposal } from '@/entities/home-conversation';
import { userSessionReducer } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';

import { useHomePlanningRecords } from './use-home-planning-records';

const api = vi.hoisted(() => ({
  acceptHomeProposal: vi.fn(),
  cancelHomeProposal: vi.fn(),
  editHomeProposalItem: vi.fn(),
  getHomeProposal: vi.fn(),
  listHomeProposals: vi.fn(),
  removeHomeProposalItem: vi.fn(),
  resumeHomeProposal: vi.fn(),
  getProject: vi.fn(),
  getGlobalTask: vi.fn(),
  getTaskActionReceipt: vi.fn(),
  undoTaskAction: vi.fn()
}));

vi.mock('@/entities/home-conversation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/home-conversation')>(),
  ...api
}));
vi.mock('@/entities/project', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/project')>(),
  getProject: api.getProject
}));
vi.mock('@/entities/project-task', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/entities/project-task')>(),
  getGlobalTask: api.getGlobalTask,
  getTaskActionReceipt: api.getTaskActionReceipt,
  undoTaskAction: api.undoTaskAction
}));

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '33333333-3333-4333-8333-333333333333';
const RECEIPT_ID = '44444444-4444-4444-8444-444444444444';
const WORKSPACE_ID = '55555555-5555-4555-8555-555555555555';
const PROPOSAL_ID = '66666666-6666-4666-8666-666666666666';
const ITEM_ID = '77777777-7777-4777-8777-777777777777';
const NOW = '2026-10-16T00:00:00.000Z';

const reviewProposal: HomeProposal = {
  id: PROPOSAL_ID,
  sourceTurnId: TURN_ID,
  scope: { kind: 'home' },
  state: 'review_required',
  revision: 1,
  acceptedRevision: null,
  acceptanceId: null,
  itemCount: 1,
  createdAt: NOW,
  updatedAt: NOW,
  items: [{
    id: ITEM_ID, position: 0, action: 'task.create',
    command: { action: 'task.create', taskId: '88888888-8888-4888-8888-888888888888', title: 'Prepare release checklist', details: null, workspaceId: null, importance: 'medium', deadline: null, subtasks: [] },
    deadlineResolution: null,
    state: 'ready', receiptId: null, resultCode: null
  }]
};

function wrapper({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const store = configureStore({
    reducer: { userSession: userSessionReducer },
    preloadedState: { userSession: { status: 'authenticated' as const, principal: { id: 'owner', displayName: 'User' }, csrfToken: 'csrf', expiresAt: null, errorCode: null } }
  });
  return <Provider store={store}>{children}</Provider>;
}

function receiptEvent(): HomeConversationEvent {
  return {
    sequence: 1, type: 'action.receipt', turnId: TURN_ID, entityId: RECEIPT_ID,
    payload: { actionKind: 'task.create', targetKind: 'workspace', targetId: WORKSPACE_ID }, createdAt: NOW
  };
}

function baseOptions(conversationId: string | null = CONVERSATION_ID) {
  return { conversationId, events: [] as readonly HomeConversationEvent[], eventsConversationId: null as string | null, refreshEvents: vi.fn(async () => undefined) };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listHomeProposals.mockResolvedValue({ proposals: [], nextCursor: null });
  api.getHomeProposal.mockResolvedValue(reviewProposal);
  api.getProject.mockResolvedValue({ id: WORKSPACE_ID, name: 'Release planning', slug: 'release-planning', relativeRoot: null, status: 'active', version: 1, createdAt: NOW, updatedAt: NOW });
  api.getTaskActionReceipt.mockResolvedValue({ id: RECEIPT_ID, actionKind: 'workspace.create', targetKind: 'workspace', targetId: WORKSPACE_ID, postVersion: 1, undoStatus: 'available', undoActionId: null });
  api.getGlobalTask.mockResolvedValue({ task: { id: '88888888-8888-4888-8888-888888888888' }, collection: 'inbox', workspace: null });
});

describe('useHomePlanningRecords', () => {
  it('hydrates saved receipts after a same-conversation event refresh', async () => {
    const options = baseOptions();
    const { result, rerender } = renderHook((props) => useHomePlanningRecords(props), { initialProps: options, wrapper });
    await waitFor(() => expect(result.current.proposalsState).toBe('ready'));
    expect(result.current.receipts).toHaveLength(0);

    rerender({ ...options, events: [receiptEvent()], eventsConversationId: CONVERSATION_ID });
    await waitFor(() => expect(result.current.receipts[0]?.state).toBe('ready'));
    expect(result.current.receipts[0]?.target).toMatchObject({ id: WORKSPACE_ID, name: 'Release planning' });
    expect(api.getProject).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it('ignores a late receipt response after switching conversations within the same scope', async () => {
    let resolveReceipt: ((value: unknown) => void) | undefined;
    api.getTaskActionReceipt.mockReturnValueOnce(new Promise((resolve) => { resolveReceipt = resolve; }));
    const first = { ...baseOptions(), events: [receiptEvent()], eventsConversationId: CONVERSATION_ID };
    const { result, rerender } = renderHook((props) => useHomePlanningRecords(props), { initialProps: first, wrapper });
    await waitFor(() => expect(api.getTaskActionReceipt).toHaveBeenCalledWith(RECEIPT_ID));

    rerender({ ...baseOptions(SECOND_CONVERSATION_ID), events: [], eventsConversationId: SECOND_CONVERSATION_ID });
    await act(async () => {
      resolveReceipt?.({ id: RECEIPT_ID, actionKind: 'workspace.create', targetKind: 'workspace', targetId: WORKSPACE_ID, postVersion: 1, undoStatus: 'available', undoActionId: null });
    });
    await waitFor(() => expect(result.current.receipts).toEqual([]));
    expect(api.getProject).not.toHaveBeenCalled();
  });

  it('retains reason-specific Undo conflict copy after authoritative receipt refresh', async () => {
    api.undoTaskAction.mockRejectedValueOnce(new ApiClientError(409, 'ACTION_UNDO_CONFLICT', 'Conflict', [], { reason: 'workspace_not_empty' }));
    const options = { ...baseOptions(), events: [receiptEvent()], eventsConversationId: CONVERSATION_ID };
    const { result } = renderHook((props) => useHomePlanningRecords(props), { initialProps: options, wrapper });
    await waitFor(() => expect(result.current.receipts[0]?.state).toBe('ready'));
    await act(async () => { await result.current.undoReceipt(RECEIPT_ID); });
    expect(result.current.receipts[0]?.undoError).toBe('Undo was not applied because this workspace still has tasks. No tasks were removed.');
    expect(result.current.receipts[0]?.conflictReason).toBe('workspace_not_empty');
    expect(api.undoTaskAction).toHaveBeenCalledTimes(1);
  });

  it('resumes only an eligible unresolved proposal after an explicit action', async () => {
    const unresolved: HomeProposal = {
      ...reviewProposal,
      state: 'unknown', revision: 2, acceptedRevision: 1, acceptanceId: '99999999-9999-4999-8999-999999999999',
      items: [{ ...reviewProposal.items[0], state: 'unknown' }]
    };
    api.listHomeProposals.mockResolvedValue({ proposals: [{ id: PROPOSAL_ID, sourceTurnId: TURN_ID, state: 'unknown', revision: 2, itemCount: 1, createdAt: NOW, updatedAt: NOW }], nextCursor: null });
    api.getHomeProposal.mockResolvedValue(unresolved);
    api.resumeHomeProposal.mockResolvedValue({ proposal: { ...unresolved, state: 'completed', items: [{ ...unresolved.items[0], state: 'saved', receiptId: RECEIPT_ID }] }, execution: { state: 'completed', items: [] }, replayed: false });
    const refreshEvents = vi.fn(async () => undefined);
    const { result } = renderHook(() => useHomePlanningRecords({ ...baseOptions(), refreshEvents }), { wrapper });
    await waitFor(() => expect(result.current.proposals[0]?.proposal.state).toBe('unknown'));
    expect(api.resumeHomeProposal).not.toHaveBeenCalled();
    await act(async () => { await result.current.resumeProposal(PROPOSAL_ID); });
    expect(api.resumeHomeProposal).toHaveBeenCalledWith(CONVERSATION_ID, PROPOSAL_ID, 'csrf');
    expect(refreshEvents).toHaveBeenCalledTimes(1);
    expect(result.current.proposals[0]?.proposal.state).toBe('completed');
  });
});
