import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cancelHomeTurn,
  createHomeConversation,
  decideHomeConsent,
  listHomeConversations,
  listHomeEvents,
  submitHomeTurn
} from '@/entities/home-conversation/api/home-conversation-api';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '33333333-3333-4333-8333-333333333333';
const DISCLOSURE_ID = '44444444-4444-4444-8444-444444444444';

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('Home conversation API', () => {
  it('loads a workspace-scoped history page with its cursor', async () => {
    const fetchMock = vi.fn().mockImplementation(() => response({ conversations: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    await listHomeConversations({ kind: 'workspace', workspaceId: WORKSPACE_ID }, 'cursor + next');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/home/conversations?scope=workspace&limit=50&workspaceId=${WORKSPACE_ID}&cursor=cursor+%2B+next`);
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(options).toMatchObject({ method: 'GET', credentials: 'include' });
  });

  it('keeps create and turn submission as separate idempotent writes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: CONVERSATION_ID, replayed: true }))
      .mockResolvedValueOnce(response({ replayed: true }));
    vi.stubGlobal('fetch', fetchMock);

    await createHomeConversation({ kind: 'home' }, 'Write a plan', 'csrf', 'create-key');
    await submitHomeTurn(CONVERSATION_ID, 'Write a plan', 'csrf', 'turn-key');

    const createOptions = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const submitOptions = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/home/conversations');
    expect(createOptions).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ scope: { kind: 'home' }, title: 'Write a plan' }),
    });
    expect((createOptions.headers as Headers).get('X-CSRF-Token')).toBe('csrf');
    expect((createOptions.headers as Headers).get('Idempotency-Key')).toBe('create-key');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/home/conversations/${CONVERSATION_ID}/turns`);
    expect(submitOptions).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ message: 'Write a plan' })
    });
    expect((submitOptions.headers as Headers).get('X-CSRF-Token')).toBe('csrf');
    expect((submitOptions.headers as Headers).get('Idempotency-Key')).toBe('turn-key');
  });

  it('replays events from the committed sequence with the bounded page size', async () => {
    const fetchMock = vi.fn().mockImplementation(() => response({ events: [], nextAfterSequence: null, lastEventSequence: 7 }));
    vi.stubGlobal('fetch', fetchMock);

    await listHomeEvents(CONVERSATION_ID, 7);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/home/conversations/${CONVERSATION_ID}/events?afterSequence=7&limit=100`);
  });

  it('sends decisions and cancellation only to their explicit scoped turn routes', async () => {
    const fetchMock = vi.fn().mockImplementation(() => response({ turn: {}, replayed: false }));
    vi.stubGlobal('fetch', fetchMock);

    await decideHomeConsent(CONVERSATION_ID, TURN_ID, DISCLOSURE_ID, 'deny', 'csrf');
    await cancelHomeTurn(CONVERSATION_ID, TURN_ID, 'csrf');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/home/conversations/${CONVERSATION_ID}/turns/${TURN_ID}/consent-decisions`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({ disclosureId: DISCLOSURE_ID, decision: 'deny' }) });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/home/conversations/${CONVERSATION_ID}/turns/${TURN_ID}/cancellation`);
  });
});
