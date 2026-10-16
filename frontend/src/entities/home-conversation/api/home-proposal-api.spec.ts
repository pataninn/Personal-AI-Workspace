import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/shared/api';
import { acceptHomeProposal, editHomeProposalItem, getHomeProposal, listHomeProposals, removeHomeProposalItem, resumeHomeProposal } from '@/entities/home-conversation/api/home-proposal-api';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const TURN_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
const ITEM_ID = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '55555555-5555-4555-8555-555555555555';
const RECEIPT_ID = '66666666-6666-4666-8666-666666666666';

const proposal = {
  id: PROPOSAL_ID,
  sourceTurnId: TURN_ID,
  scope: { kind: 'home' },
  state: 'review_required',
  revision: 2,
  acceptedRevision: null,
  acceptanceId: null,
  itemCount: 1,
  createdAt: '2026-10-16T10:00:00.000Z',
  updatedAt: '2026-10-16T10:05:00.000Z',
  items: [{
    id: ITEM_ID,
    position: 0,
    action: 'task.update',
    command: { action: 'task.update', taskId: TASK_ID, expectedVersion: 4, title: 'Polish the proposal', deadline: '2026-10-20' },
    state: 'ready',
    receiptId: null,
    resultCode: null
  }]
} as const;

const fetchMock = vi.fn<typeof fetch>();

describe('Home proposal API', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads bounded proposal pages and validates persisted preview commands', async () => {
    fetchMock.mockResolvedValueOnce(envelope({
      proposals: [{ id: PROPOSAL_ID, sourceTurnId: TURN_ID, state: 'review_required', revision: 2, itemCount: 1, createdAt: proposal.createdAt, updatedAt: proposal.updatedAt }],
      nextCursor: 'opaque-cursor'
    }));
    await expect(listHomeProposals(CONVERSATION_ID)).resolves.toMatchObject({ proposals: [{ id: PROPOSAL_ID, itemCount: 1 }], nextCursor: 'opaque-cursor' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/home/conversations/${CONVERSATION_ID}/proposals?limit=50`);

    fetchMock.mockResolvedValueOnce(envelope({ proposal }));
    await expect(getHomeProposal(CONVERSATION_ID, PROPOSAL_ID)).resolves.toMatchObject({
      state: 'review_required', revision: 2, scope: { kind: 'home' },
      items: [{ id: ITEM_ID, command: { action: 'task.update', taskId: TASK_ID, expectedVersion: 4, deadline: '2026-10-20' } }]
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/home/conversations/${CONVERSATION_ID}/proposals/${PROPOSAL_ID}`);

    fetchMock.mockResolvedValueOnce(envelope({ proposal: { ...proposal, items: [{ ...proposal.items[0], command: { ...proposal.items[0].command, action: 'task.archive' } }] } }));
    await expect(getHomeProposal(CONVERSATION_ID, PROPOSAL_ID)).rejects.toBeInstanceOf(ApiClientError);
  });

  it('saves edits and removals against the exact draft revision', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ proposal: { ...proposal, revision: 3, updatedAt: '2026-10-16T10:06:00.000Z' } }));
    await expect(editHomeProposalItem(CONVERSATION_ID, PROPOSAL_ID, ITEM_ID, 2, { title: 'Polish the launch proposal' }, 'csrf'))
      .resolves.toMatchObject({ revision: 3 });
    const [patchPath, patchRequest] = fetchMock.mock.calls[0] ?? [];
    expect(patchPath).toBe(`/api/v1/home/conversations/${CONVERSATION_ID}/proposals/${PROPOSAL_ID}/items/${ITEM_ID}`);
    expect(patchRequest?.method).toBe('PATCH');
    expect(JSON.parse(String(patchRequest?.body))).toEqual({ expectedRevision: 2, changes: { title: 'Polish the launch proposal' } });
    expect(new Headers(patchRequest?.headers).get('X-CSRF-Token')).toBe('csrf');

    fetchMock.mockResolvedValueOnce(envelope({ proposal: { ...proposal, revision: 4, itemCount: 0, items: [], updatedAt: '2026-10-16T10:07:00.000Z' } }));
    await expect(removeHomeProposalItem(CONVERSATION_ID, PROPOSAL_ID, ITEM_ID, 3, 'csrf')).resolves.toMatchObject({ itemCount: 0, items: [] });
    const [deletePath, deleteRequest] = fetchMock.mock.calls[1] ?? [];
    expect(deletePath).toBe(`/api/v1/home/conversations/${CONVERSATION_ID}/proposals/${PROPOSAL_ID}/items/${ITEM_ID}`);
    expect(deleteRequest?.method).toBe('DELETE');
    expect(new Headers(deleteRequest?.headers).get('If-Match')).toBe('"3"');
    expect(new Headers(deleteRequest?.headers).get('X-CSRF-Token')).toBe('csrf');
  });

  it('preserves server-supplied relative deadline zone provenance without guessing from the browser', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ proposal: { ...proposal, items: [{
      ...proposal.items[0], deadlineResolution: { timeZone: 'America/Los_Angeles', source: 'configured' }
    }] } }));
    await expect(getHomeProposal(CONVERSATION_ID, PROPOSAL_ID)).resolves.toMatchObject({
      items: [{ command: { deadline: '2026-10-20' }, deadlineResolution: { timeZone: 'America/Los_Angeles', source: 'configured' } }]
    });

    fetchMock.mockResolvedValueOnce(envelope({ proposal: { ...proposal, items: [{
      ...proposal.items[0], deadlineResolution: { timeZone: 'UTC', source: 'utc-fallback' }
    }] } }));
    await expect(getHomeProposal(CONVERSATION_ID, PROPOSAL_ID)).resolves.toMatchObject({
      items: [{ deadlineResolution: { timeZone: 'UTC', source: 'utc-fallback' } }]
    });

    fetchMock.mockResolvedValueOnce(envelope({ proposal: { ...proposal, items: [{
      ...proposal.items[0], deadlineResolution: { timeZone: 'local', source: 'guessed' }
    }] } }));
    await expect(getHomeProposal(CONVERSATION_ID, PROPOSAL_ID)).rejects.toBeInstanceOf(ApiClientError);
  });

  it('accepts only a sealed revision and exposes persisted outcome and receipt IDs', async () => {
    const accepted = { ...proposal, state: 'partial', revision: 3, acceptedRevision: 2, acceptanceId: ITEM_ID,
      items: [{ ...proposal.items[0], state: 'saved', receiptId: RECEIPT_ID }] };
    fetchMock.mockResolvedValueOnce(envelope({ proposal: accepted, acceptance: { id: ITEM_ID, revision: 2 }, execution: { state: 'partial', items: [{ itemId: ITEM_ID, state: 'saved', receiptId: RECEIPT_ID, resultCode: null }] }, replayed: false }));
    await expect(acceptHomeProposal(CONVERSATION_ID, PROPOSAL_ID, 2, 'csrf')).resolves.toMatchObject({
      proposal: { state: 'partial', acceptedRevision: 2, items: [{ state: 'saved', receiptId: RECEIPT_ID }] },
      execution: { state: 'partial', items: [{ itemId: ITEM_ID, receiptId: RECEIPT_ID }] },
      acceptance: { revision: 2 }, replayed: false
    });
    const [path, request] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/v1/home/conversations/${CONVERSATION_ID}/proposals/${PROPOSAL_ID}/acceptance`);
    expect(JSON.parse(String(request?.body))).toEqual({ expectedRevision: 2 });
    expect(new Headers(request?.headers).get('X-CSRF-Token')).toBe('csrf');
  });

  it('uses an explicit empty-body resume request and does not invent outcomes', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ proposal: { ...proposal, state: 'unknown', revision: 3, acceptedRevision: 2, acceptanceId: ITEM_ID,
      items: [{ ...proposal.items[0], state: 'unknown', resultCode: 'OUTCOME_UNKNOWN' }] }, execution: { state: 'unknown', items: [{ itemId: ITEM_ID, state: 'unknown', receiptId: null, resultCode: 'OUTCOME_UNKNOWN' }] }, replayed: false }));
    await expect(resumeHomeProposal(CONVERSATION_ID, PROPOSAL_ID, 'csrf')).resolves.toMatchObject({
      proposal: { state: 'unknown', items: [{ state: 'unknown', receiptId: null }] }, execution: { state: 'unknown' }
    });
    const [path, request] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/v1/home/conversations/${CONVERSATION_ID}/proposals/${PROPOSAL_ID}/execution`);
    expect(JSON.parse(String(request?.body))).toEqual({});
    expect(new Headers(request?.headers).get('X-CSRF-Token')).toBe('csrf');
  });
});

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
