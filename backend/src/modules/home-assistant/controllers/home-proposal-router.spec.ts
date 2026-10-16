import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';

import { HomeConversationDomainError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { HomeProposalRevisionConflictError } from '@/modules/home-assistant/domain/home-planning-errors';
import type { HomeChangeProposal } from '@/modules/home-assistant/domain/home-change-proposal-types';
import type { HomeProposalExecutionResult } from '@/modules/home-assistant/use-cases/home-change-proposal-use-cases';
import { createHomeProposalRouter, type HomeProposalRouterDependencies } from '@/modules/home-assistant/controllers/home-proposal-router';
import { AppError } from '@/shared/errors/app-error';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
const ITEM_ID = '44444444-4444-4444-8444-444444444444';
const TURN_ID = '55555555-5555-4555-8555-555555555555';
const ACCEPTANCE_ID = '66666666-6666-4666-8666-666666666666';
const ORIGIN = 'https://127.0.0.1:8443';
const NOW = new Date('2026-10-16T00:00:00.000Z');

const proposal: HomeChangeProposal = {
  id: PROPOSAL_ID,
  ownerId: OWNER_ID,
  conversationId: CONVERSATION_ID,
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
    id: ITEM_ID, position: 0, action: 'task.create', targetKind: 'task', targetId: '77777777-7777-4777-8777-777777777777',
    expectedVersion: null, state: 'ready', operationKey: null, requestFingerprint: null, receiptId: null, resultCode: null,
    command: { action: 'task.create', taskId: '77777777-7777-4777-8777-777777777777', title: 'Review a plan', details: null, workspaceId: null, importance: 'medium', deadline: null, subtasks: [] }
  }]
};

function buildApp() {
  const list = jest.fn(async () => ({ proposals: [], nextCursor: null }));
  const get = jest.fn(async () => proposal);
  const editItem = jest.fn(async () => proposal);
  const removeItem = jest.fn(async () => proposal);
  const accept = jest.fn(async (): Promise<HomeProposalExecutionResult> => ({
    proposal: { ...proposal, state: 'completed', acceptedRevision: 1, acceptanceId: ACCEPTANCE_ID },
    execution: { state: 'completed', items: [{ itemId: ITEM_ID, state: 'saved', receiptId: '88888888-8888-4888-8888-888888888888', resultCode: null }] },
    replayed: false
  }));
  const execute = jest.fn(async (): Promise<HomeProposalExecutionResult> => ({
    proposal: { ...proposal, state: 'completed', acceptedRevision: 1, acceptanceId: ACCEPTANCE_ID },
    execution: { state: 'completed', items: [] }, replayed: true
  }));
  const cancel = jest.fn(async () => ({ ...proposal, state: 'cancelled' as const }));
  const dependencies = {
    getSession: { execute: jest.fn(async () => ({
      sessionId: 'session', principal: { id: OWNER_ID, displayName: 'Local user' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000)
    })) },
    proposals: { list, get, editItem, removeItem, accept, execute, cancel },
    appOrigin: ORIGIN,
    clearSessionCookie: jest.fn()
  } as unknown as HomeProposalRouterDependencies;
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1', createHomeProposalRouter(dependencies));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HomeConversationDomainError) {
      response.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message } });
      return;
    }
    const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 500, 'Internal server error.');
    response.status(appError.statusCode).json({ data: null, error: { code: appError.code, message: appError.message } });
  });
  return { app, list, get, editItem, removeItem, accept, execute, cancel };
}

function mutationHeaders(): Record<string, string> {
  return { Cookie: '__Host-pa_session=session-token', Origin: ORIGIN, 'X-CSRF-Token': 'csrf-token' };
}

describe('Home proposal routes', () => {
  it('returns proposal detail without exposing persistence ownership fields', async () => {
    const { app, get } = buildApp();
    const response = await request(app)
      .get(`/api/v1/home/conversations/${CONVERSATION_ID}/proposals/${PROPOSAL_ID}`)
      .set('Cookie', '__Host-pa_session=session-token');

    expect(response.status).toBe(200);
    expect(response.body.data.proposal).toMatchObject({ id: PROPOSAL_ID, sourceTurnId: TURN_ID, state: 'review_required', items: [{ id: ITEM_ID }] });
    expect(response.body.data.proposal).not.toHaveProperty('ownerId');
    expect(get).toHaveBeenCalledWith(OWNER_ID, CONVERSATION_ID, PROPOSAL_ID);
  });

  it('returns 400 for an unsupported state before querying proposals', async () => {
    const { app, list } = buildApp();
    const response = await request(app)
      .get(`/api/v1/home/conversations/${CONVERSATION_ID}/proposals?state=not-a-state`)
      .set('Cookie', '__Host-pa_session=session-token');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(list).not.toHaveBeenCalled();
  });

  it('requires origin and CSRF before accepting a displayed revision', async () => {
    const { app, accept } = buildApp();
    const response = await request(app)
      .post(`/api/v1/home/conversations/${CONVERSATION_ID}/proposals/${PROPOSAL_ID}/acceptance`)
      .set('Cookie', '__Host-pa_session=session-token')
      .send({ expectedRevision: 1 });

    expect(response.status).toBe(403);
    expect(accept).not.toHaveBeenCalled();
  });

  it('accepts the exact revision and returns the stable acceptance ID and execution result', async () => {
    const { app, accept } = buildApp();
    const response = await request(app)
      .post(`/api/v1/home/conversations/${CONVERSATION_ID}/proposals/${PROPOSAL_ID}/acceptance`)
      .set(mutationHeaders())
      .send({ expectedRevision: 1 });

    expect(response.status).toBe(201);
    expect(response.headers.location).toBe(`/api/v1/home/conversations/${CONVERSATION_ID}/proposals/${PROPOSAL_ID}/acceptance/${ACCEPTANCE_ID}`);
    expect(response.headers.etag).toBe('"1"');
    expect(response.body.data).toMatchObject({ acceptance: { id: ACCEPTANCE_ID, revision: 1 }, execution: { state: 'completed' }, replayed: false });
    expect(accept).toHaveBeenCalledWith({ ownerId: OWNER_ID, conversationId: CONVERSATION_ID, proposalId: PROPOSAL_ID, expectedRevision: 1 });
  });

  it('maps a stale proposal revision to a 409 conflict response', async () => {
    const { app, accept } = buildApp();
    accept.mockRejectedValueOnce(new HomeProposalRevisionConflictError());
    const response = await request(app)
      .post(`/api/v1/home/conversations/${CONVERSATION_ID}/proposals/${PROPOSAL_ID}/acceptance`)
      .set(mutationHeaders())
      .send({ expectedRevision: 2 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('HOME_PROPOSAL_REVISION_CONFLICT');
  });
});
