import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';

import { HomeConversationCursorInvalidError, HomeConversationDomainError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeConversationEventPage, HomeMessage, HomeTurn, HomeTurnSubmission } from '@/modules/home-assistant/domain/home-conversation-types';
import { createHomeConversationRouter, type HomeConversationRouterDependencies } from '@/modules/home-assistant/controllers/home-conversation-router';
import { AppError } from '@/shared/errors/app-error';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const TURN_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const ORIGIN = 'https://127.0.0.1:8443';
const NOW = new Date('2026-10-16T00:00:00.000Z');

const turn: HomeTurn = {
  id: TURN_ID, ownerId: OWNER_ID, conversationId: CONVERSATION_ID, sequence: 1, requestKey: 'submit-1',
  status: 'unsupported', homePolicyRevision: null, workspacePolicyRevision: null, createdAt: NOW, updatedAt: NOW
};
const message: HomeMessage = {
  id: MESSAGE_ID, ownerId: OWNER_ID, conversationId: CONVERSATION_ID, turnId: TURN_ID,
  sequence: 1, role: 'user', content: 'Make a plan.', createdAt: NOW
};

function buildApp(): {
  readonly app: express.Express;
  readonly submitTurn: jest.Mock;
  readonly listEvents: jest.Mock;
  readonly listConversations: jest.Mock;
  readonly listTurns: jest.Mock;
  readonly listSkillRunSummaries: jest.Mock;
  readonly decideConsent: jest.Mock;
} {
  const submitTurn = jest.fn(async (): Promise<HomeTurnSubmission> => ({ turn, message, replayed: false }));
  const listConversations = jest.fn();
  const listTurns = jest.fn();
  const listSkillRunSummaries = jest.fn();
  const decideConsent = jest.fn();
  const listEvents = jest.fn(async (): Promise<HomeConversationEventPage> => ({
    events: [{ sequence: 2, type: 'message.appended', turnId: TURN_ID, entityId: MESSAGE_ID, payload: { role: 'user', messageSequence: 1 }, createdAt: NOW }],
    nextAfterSequence: null,
    lastEventSequence: 2
  }));
  const dependencies = {
    getSession: { execute: jest.fn(async () => ({
      sessionId: 'session', principal: { id: OWNER_ID, displayName: 'Local user' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000)
    })) },
    listConversations: { execute: listConversations },
    createConversation: { execute: jest.fn() },
    getConversation: { execute: jest.fn() },
    listTurns: { execute: listTurns },
    listSkillRunSummaries: { execute: listSkillRunSummaries },
    submitTurn: { execute: submitTurn },
    decideConsent: { execute: decideConsent },
    getTurn: { execute: jest.fn() },
    cancelTurn: { execute: jest.fn() },
    listMessages: { execute: jest.fn() },
    listEvents: { execute: listEvents },
    appOrigin: ORIGIN,
    clearSessionCookie: jest.fn()
  } as unknown as HomeConversationRouterDependencies;
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1', createHomeConversationRouter(dependencies));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HomeConversationDomainError) {
      response.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message } });
      return;
    }
    const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 500, 'Internal server error.');
    response.status(appError.statusCode).json({ data: null, error: { code: appError.code, message: appError.message } });
  });
  return { app, submitTurn, listEvents, listConversations, listTurns, listSkillRunSummaries, decideConsent };
}

function mutationHeaders(): Record<string, string> {
  return {
    Cookie: '__Host-pa_session=session-token',
    Origin: ORIGIN,
    'X-CSRF-Token': 'csrf-token',
    'Idempotency-Key': 'submit-1'
  };
}

describe('Home conversation routes', () => {
  it('requires origin and CSRF before submitting a durable turn', async () => {
    const { app, submitTurn } = buildApp();

    const blocked = await request(app)
      .post(`/api/v1/home/conversations/${CONVERSATION_ID}/turns`)
      .set('Cookie', '__Host-pa_session=session-token')
      .send({ message: 'Make a plan.' });
    expect(blocked.status).toBe(403);
    expect(submitTurn).not.toHaveBeenCalled();

    const saved = await request(app)
      .post(`/api/v1/home/conversations/${CONVERSATION_ID}/turns`)
      .set(mutationHeaders())
      .send({ message: 'Make a plan.' });
    expect(saved.status).toBe(201);
    expect(saved.body.data).toMatchObject({
      turn: { id: TURN_ID, status: 'unsupported' },
      message: { id: MESSAGE_ID, role: 'user' },
      execution: { state: 'unsupported', code: 'PLANNING_RUNTIME_UNAVAILABLE' },
      replayed: false
    });
    expect(saved.body.data).not.toHaveProperty('assistantMessage');
    expect(submitTurn).toHaveBeenCalledWith({ ownerId: OWNER_ID, conversationId: CONVERSATION_ID, requestKey: 'submit-1', message: 'Make a plan.' });
  });

  it('rejects unknown submission fields before application work', async () => {
    const { app, submitTurn } = buildApp();
    const invalid = await request(app)
      .post(`/api/v1/home/conversations/${CONVERSATION_ID}/turns`)
      .set(mutationHeaders())
      .send({ message: 'Make a plan.', ownerId: 'attacker' });

    expect(invalid.status).toBe(400);
    expect(submitTurn).not.toHaveBeenCalled();
  });

  it('returns the initial disclosure before provider context is sent', async () => {
    const { app, submitTurn } = buildApp();
    submitTurn.mockResolvedValueOnce({
      turn: { ...turn, status: 'pending' },
      message,
      execution: {
        state: 'consent_required',
        disclosure: {
          disclosureId: '55555555-5555-4555-8555-555555555555',
          phase: 'initial',
          provider: { profile: 'nvidia-hosted-nim', name: 'NVIDIA hosted NIM', model: 'test-model' },
          scope: { kind: 'home' },
          categories: ['current_message'],
          itemCount: 1,
          byteLimit: 262144
        }
      },
      disclosure: {
        disclosureId: '55555555-5555-4555-8555-555555555555', ownerId: OWNER_ID, conversationId: CONVERSATION_ID, turnId: TURN_ID,
        phase: 'initial', providerProfile: 'nvidia-hosted-nim', providerName: 'NVIDIA hosted NIM', model: 'test-model', scope: { kind: 'home' },
        categories: ['current_message'], itemCount: 1, byteLimit: 262144, runtimeRequestId: null, resultFingerprint: null, decision: null, deliveryState: 'awaiting_decision',
        createdAt: NOW, updatedAt: NOW
      },
      replayed: false
    });

    const response = await request(app)
      .post(`/api/v1/home/conversations/${CONVERSATION_ID}/turns`)
      .set(mutationHeaders())
      .send({ message: 'Make a plan.' });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      turn: { id: TURN_ID, status: 'pending' },
      execution: {
        state: 'consent_required',
        disclosure: {
          disclosureId: '55555555-5555-4555-8555-555555555555',
          phase: 'initial',
          provider: { profile: 'nvidia-hosted-nim', model: 'test-model' },
          categories: ['current_message'],
          itemCount: 1,
          byteLimit: 262144
        }
      },
      replayed: false
    });
    expect(response.body.data.execution).not.toHaveProperty('prompt');
    expect(submitTurn).toHaveBeenCalledTimes(1);
  });

  it.each(['allow', 'deny'] as const)('retires the legacy Home %s consent decision without invoking its use case', async (decision) => {
    const { app, decideConsent } = buildApp();
    const response = await request(app)
      .post(`/api/v1/home/conversations/${CONVERSATION_ID}/turns/${TURN_ID}/consent-decisions`)
      .set(mutationHeaders())
      .send({ disclosureId: '55555555-5555-4555-8555-555555555555', decision });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('POLICY_ACTION_RETIRED');
    expect(decideConsent).not.toHaveBeenCalled();
  });

  it('returns a validation response for an invalid activity cursor', async () => {
    const { app, listConversations } = buildApp();
    listConversations.mockRejectedValue(new HomeConversationCursorInvalidError());

    const response = await request(app)
      .get('/api/v1/home/conversations?scope=home&cursor=not-a-cursor')
      .set('Cookie', '__Host-pa_session=session-token');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(listConversations).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      scope: { kind: 'home' },
      limit: 50,
      cursor: 'not-a-cursor'
    });
  });

  it('returns durable event sequence data and derives the owner from the session', async () => {
    const { app, listEvents } = buildApp();
    const response = await request(app)
      .get(`/api/v1/home/conversations/${CONVERSATION_ID}/events?afterSequence=1&limit=10`)
      .set('Cookie', '__Host-pa_session=session-token');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      events: [{ sequence: 2, type: 'message.appended', payload: { role: 'user', messageSequence: 1 } }],
      nextAfterSequence: null,
      lastEventSequence: 2
    });
    expect(listEvents).toHaveBeenCalledWith({ ownerId: OWNER_ID, conversationId: CONVERSATION_ID, afterSequence: 1, limit: 10 });
  });

  it('returns only the safe skill summary from the owner-scoped turn read', async () => {
    const { app, listTurns, listSkillRunSummaries } = buildApp();
    listTurns.mockResolvedValueOnce({ turns: [turn], nextAfterSequence: null });
    listSkillRunSummaries.mockResolvedValueOnce([{
      turnId: TURN_ID,
      summary: {
        title: 'Plan my day', skillVersion: 3, state: 'accepted',
        sources: [{ kind: 'project_fact', revision: 5, label: null }]
      }
    }]);

    const response = await request(app)
      .get(`/api/v1/home/conversations/${CONVERSATION_ID}/turns?afterSequence=0`)
      .set('Cookie', '__Host-pa_session=session-token');

    expect(response.status).toBe(200);
    expect(response.body.data.turns[0].skillRun).toEqual({
      title: 'Plan my day', skillVersion: 3, state: 'accepted',
      sources: [{ kind: 'project_fact', revision: 5, label: null }]
    });
    expect(response.body.data.turns[0].skillRun.sources[0]).not.toHaveProperty('id');
    expect(listSkillRunSummaries).toHaveBeenCalledWith({ ownerId: OWNER_ID, conversationId: CONVERSATION_ID, turnIds: [TURN_ID] });
  });
});
