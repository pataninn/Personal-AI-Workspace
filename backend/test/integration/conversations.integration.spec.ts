import express from 'express';
import request from 'supertest';

import type { Conversation, Message } from '@/modules/conversations/domain/conversation-types';
import {
  APP_ORIGIN,
  ConversationProjectFixture,
  ConversationRepositoryFixture,
  NOW,
  OWNER_ID,
  OTHER_OWNER_PROJECT_ID,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  buildConversationApp,
  login
} from './conversation-fixtures';

const CONVERSATION_ID = '66666666-6666-4666-8666-666666666666';
const SECOND_CONVERSATION_ID = '77777777-7777-4777-8777-777777777777';

interface TestContext {
  readonly app: express.Express;
  readonly projects: ConversationProjectFixture;
  readonly conversations: ConversationRepositoryFixture;
  readonly session: { readonly cookie: string; readonly csrf: string };
}

function makeConversation(
  id: string,
  title: string,
  lastActivityAt: Date,
  projectId = PROJECT_ID,
  ownerId = OWNER_ID
): Conversation {
  return { id, ownerId, projectId, title, status: 'active', lastActivityAt, createdAt: lastActivityAt, updatedAt: lastActivityAt };
}

function makeMessage(id: string, conversationId: string, sequence: number, content: string): Message {
  return { id, conversationId, role: sequence % 2 === 0 ? 'assistant' : 'user', sequence, content, createdAt: new Date(NOW.getTime() + sequence) };
}

describe('conversations API (integration)', () => {
  let context: TestContext;

  beforeEach(async () => {
    const projects = new ConversationProjectFixture();
    const conversations = new ConversationRepositoryFixture();
    const app = buildConversationApp(projects, conversations);
    context = { app, projects, conversations, session: await login(app) };
  });

  it('creates, lists, reads ordered history, and hides guessed or cross-project IDs', async () => {
    const { app, session } = context;
    const created = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversations`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf)
      .set('Idempotency-Key', 'create-conversation-1')
      .send({ title: '  Research notes  ' })
      .expect(201);

    expect(created.body.data).toMatchObject({ title: 'Research notes', projectId: PROJECT_ID, status: 'active' });
    const conversationId = created.body.data.id as string;

    await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}/conversations`)
      .set('Cookie', session.cookie)
      .expect(200)
      .expect(({ body }) => expect(body.data.conversations.map((conversation: Conversation) => conversation.id)).toEqual([conversationId]));

    await request(app)
      .post(`/api/v1/conversations/${conversationId}/messages?projectId=${PROJECT_ID}`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf)
      .set('Idempotency-Key', 'message-history-1')
      .send({ content: 'first message' })
      .expect(201);

    await request(app)
      .get(`/api/v1/conversations/${conversationId}?projectId=${PROJECT_ID}`)
      .set('Cookie', session.cookie)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.messages).toHaveLength(1);
        expect(body.data.messages[0]).toMatchObject({ role: 'user', sequence: 1, content: 'first message' });
      });

    await request(app)
      .get(`/api/v1/conversations/${conversationId}?projectId=${SECOND_PROJECT_ID}`)
      .set('Cookie', session.cookie)
      .expect(404)
      .expect(({ body }) => expect(body.error).toEqual({ code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found.' }));
    await request(app)
      .get(`/api/v1/conversations/99999999-9999-4999-8999-999999999999?projectId=${PROJECT_ID}`)
      .set('Cookie', session.cookie)
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('CONVERSATION_NOT_FOUND'));
    await request(app)
      .get(`/api/v1/projects/${OTHER_OWNER_PROJECT_ID}/conversations`)
      .set('Cookie', session.cookie)
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe('PROJECT_NOT_FOUND'));
  });

  it('returns a stable activity cursor and rejects malformed query input', async () => {
    const { app, conversations, session } = context;
    conversations.seed(makeConversation(CONVERSATION_ID, 'Newest', new Date('2026-09-12T14:00:00.000Z')));
    conversations.seed(makeConversation(SECOND_CONVERSATION_ID, 'Middle', new Date('2026-09-12T13:00:00.000Z')));
    conversations.seed(makeConversation('88888888-8888-4888-8888-888888888888', 'Oldest', new Date('2026-09-12T12:00:00.000Z')));

    const firstPage = await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}/conversations?limit=2`)
      .set('Cookie', session.cookie)
      .expect(200);
    expect(firstPage.body.data.conversations.map((conversation: Conversation) => conversation.title)).toEqual(['Newest', 'Middle']);
    expect(firstPage.body.data.nextCursor).toEqual(expect.any(String));

    await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}/conversations?limit=2&cursor=${encodeURIComponent(firstPage.body.data.nextCursor as string)}`)
      .set('Cookie', session.cookie)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.conversations.map((conversation: Conversation) => conversation.title)).toEqual(['Oldest']);
        expect(body.data.nextCursor).toBeNull();
      });

    await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}/conversations?limit=0`)
      .set('Cookie', session.cookie)
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));
    await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}/conversations?cursor=not-a-cursor`)
      .set('Cookie', session.cookie)
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));
  });

  it('replays identical create/message intents and conflicts on changed payloads', async () => {
    const { app, session } = context;
    const createRequest = () => request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversations`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf)
      .set('Idempotency-Key', 'create-replay-key')
      .send({ title: 'Retry-safe conversation' });
    const first = await createRequest().expect(201);
    const replay = await createRequest().expect(200);
    expect(replay.body).toEqual(first.body);

    await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversations`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf)
      .set('Idempotency-Key', 'create-replay-key')
      .send({ title: 'Changed conversation' })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED'));

    const conversationId = first.body.data.id as string;
    const messageRequest = () => request(app)
      .post(`/api/v1/conversations/${conversationId}/messages?projectId=${PROJECT_ID}`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf)
      .set('Idempotency-Key', 'message-replay-key')
      .send({ content: 'Keep this exactly once' });
    const message = await messageRequest().expect(201);
    const messageReplay = await messageRequest().expect(200);
    expect(messageReplay.body).toEqual(message.body);

    await request(app)
      .post(`/api/v1/conversations/${conversationId}/messages?projectId=${PROJECT_ID}`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf)
      .set('Idempotency-Key', 'message-replay-key')
      .send({ content: 'Changed after transport retry' })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED'));
  });

  it('keeps archived projects readable while rejecting both mutations', async () => {
    const { app, projects, session } = context;
    const created = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversations`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf)
      .set('Idempotency-Key', 'archive-test-create')
      .send({ title: 'Read-only history' })
      .expect(201);
    const conversationId = created.body.data.id as string;
    projects.archive(PROJECT_ID);

    await request(app).get(`/api/v1/projects/${PROJECT_ID}/conversations`).set('Cookie', session.cookie).expect(200);
    await request(app).get(`/api/v1/conversations/${conversationId}?projectId=${PROJECT_ID}`).set('Cookie', session.cookie).expect(200);
    await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversations`)
      .set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('Idempotency-Key', 'archive-test-new')
      .send({ title: 'Should fail' }).expect(409).expect(({ body }) => expect(body.error.code).toBe('PROJECT_ARCHIVED'));
    await request(app)
      .post(`/api/v1/conversations/${conversationId}/messages?projectId=${PROJECT_ID}`)
      .set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('Idempotency-Key', 'archive-test-message')
      .send({ content: 'Should fail' }).expect(409).expect(({ body }) => expect(body.error.code).toBe('PROJECT_ARCHIVED'));
  });

  it('rejects a message key reused across conversations without creating a second message', async () => {
    const { app, session } = context;
    const createConversationRequest = (key: string, title: string) => request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversations`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf)
      .set('Idempotency-Key', key)
      .send({ title });
    const firstConversation = await createConversationRequest('cross-conversation-create-1', 'First target').expect(201);
    const secondConversation = await createConversationRequest('cross-conversation-create-2', 'Second target').expect(201);
    const firstId = firstConversation.body.data.id as string;
    const secondId = secondConversation.body.data.id as string;
    const messageRequest = (conversationId: string) => request(app)
      .post(`/api/v1/conversations/${conversationId}/messages?projectId=${PROJECT_ID}`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf)
      .set('Idempotency-Key', 'shared-message-key')
      .send({ content: 'Only the first conversation receives this.' });

    await messageRequest(firstId).expect(201);
    await messageRequest(secondId).expect(409).expect(({ body }) => expect(body.error.code).toBe('IDEMPOTENCY_KEY_REUSED'));
    await request(app).get(`/api/v1/conversations/${secondId}?projectId=${PROJECT_ID}`).set('Cookie', session.cookie).expect(200).expect(({ body }) => {
      expect(body.data.messages).toEqual([]);
    });
  });

  it('allocates one sequence per concurrent message and never duplicates a replay', async () => {
    const { app, session } = context;
    const created = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversations`)
      .set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('Idempotency-Key', 'sequence-test-create')
      .send({ title: 'Concurrent history' }).expect(201);
    const conversationId = created.body.data.id as string;
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => request(app)
      .post(`/api/v1/conversations/${conversationId}/messages?projectId=${PROJECT_ID}`)
      .set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
      .set('Idempotency-Key', `sequence-message-${index}`)
      .send({ content: `message-${index}` })));
    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(responses.map((response) => response.body.data.sequence).sort((left: number, right: number) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const duplicateResponses = await Promise.all([
      request(app).post(`/api/v1/conversations/${conversationId}/messages?projectId=${PROJECT_ID}`).set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('Idempotency-Key', 'sequence-replay').send({ content: 'one replay' }),
      request(app).post(`/api/v1/conversations/${conversationId}/messages?projectId=${PROJECT_ID}`).set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('Idempotency-Key', 'sequence-replay').send({ content: 'one replay' })
    ]);
    expect(duplicateResponses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(duplicateResponses[0]?.body.data.id).toBe(duplicateResponses[1]?.body.data.id);

    await request(app).get(`/api/v1/conversations/${conversationId}?projectId=${PROJECT_ID}`).set('Cookie', session.cookie).expect(200).expect(({ body }) => {
      expect(body.data.messages).toHaveLength(9);
      expect(body.data.messages.map((message: Message) => message.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
  });

  it('requires authentication, CSRF, idempotency, and an explicit history project scope', async () => {
    const { app, session } = context;
    await request(app).get(`/api/v1/projects/${PROJECT_ID}/conversations`).expect(401);
    await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversations`)
      .set('Origin', APP_ORIGIN).set('Cookie', session.cookie).send({ title: 'Missing CSRF' }).expect(403);
    await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversations`)
      .set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ title: 'Missing key' }).expect(400);
    await request(app)
      .get('/api/v1/conversations/66666666-6666-4666-8666-666666666666')
      .set('Cookie', session.cookie)
      .expect(400)
      .expect(({ body }) => expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR' }));
  });

  it('returns bounded history pages in ascending sequence order', async () => {
    const { app, conversations, session } = context;
    const conversation = makeConversation(CONVERSATION_ID, 'Paged history', NOW);
    conversations.seed(conversation, [
      makeMessage('99999999-9999-4999-8999-999999999991', conversation.id, 1, 'one'),
      makeMessage('99999999-9999-4999-8999-999999999992', conversation.id, 2, 'two'),
      makeMessage('99999999-9999-4999-8999-999999999993', conversation.id, 3, 'three'),
      makeMessage('99999999-9999-4999-8999-999999999994', conversation.id, 4, 'four')
    ]);
    const first = await request(app).get(`/api/v1/conversations/${conversation.id}?projectId=${PROJECT_ID}&limit=2`).set('Cookie', session.cookie).expect(200);
    expect(first.body.data.messages.map((message: Message) => message.sequence)).toEqual([3, 4]);
    expect(first.body.data.nextBeforeSequence).toBe(3);
    await request(app).get(`/api/v1/conversations/${conversation.id}?projectId=${PROJECT_ID}&limit=2&beforeSequence=3`).set('Cookie', session.cookie).expect(200).expect(({ body }) => {
      expect(body.data.messages.map((message: Message) => message.sequence)).toEqual([1, 2]);
      expect(body.data.nextBeforeSequence).toBeNull();
    });
  });
});
