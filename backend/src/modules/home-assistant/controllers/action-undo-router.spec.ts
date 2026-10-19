import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';

import { ActionUndoConflictError } from '@/modules/home-assistant/domain/action-undo-errors';
import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';
import { createActionUndoRouter } from '@/modules/home-assistant/controllers/action-undo-router';
import { AppError } from '@/shared/errors/app-error';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ACTION = '22222222-2222-4222-8222-222222222222';
const TURN = '55555555-5555-4555-8555-555555555555';
const ORIGIN = 'https://127.0.0.1:8443';

const original: ActionLedgerRecord = {
  id: ACTION, ownerId: OWNER, operationKey: 'create', requestFingerprint: 'fingerprint', actorKind: 'manual', turnId: null,
  targetKind: 'workspace', targetId: '33333333-3333-4333-8333-333333333333', actionKind: 'workspace.create', expectedVersion: null,
  preVersion: null, postVersion: 2, reversibleFields: {}, outcome: { targetId: '33333333-3333-4333-8333-333333333333', targetVersion: 2 },
  undoStatus: 'undone', undoOfActionId: null, undoActionId: '44444444-4444-4444-8444-444444444444', createdAt: '2026-10-16T00:00:00.000Z'
};

function appWithUndo(undoAction: { undo: jest.Mock; getReceipt?: jest.Mock }): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/actions', createActionUndoRouter({
    getSession: { execute: jest.fn(async () => ({
      sessionId: 'session', principal: { id: OWNER, displayName: 'Local user' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000)
    })) } as never,
    undoAction: undoAction as never,
    appOrigin: ORIGIN,
    clearSessionCookie: () => undefined
  }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 500, 'Internal server error.');
    response.status(appError.statusCode).json({ data: null, error: { code: appError.code, message: appError.message } });
  });
  return app;
}

function mutationHeaders(): Record<string, string> {
  return {
    Cookie: '__Host-pa_session=session-token',
    Origin: ORIGIN,
    'X-CSRF-Token': 'csrf-token',
    'Idempotency-Key': 'undo-workspace-1'
  };
}

describe('Action undo route', () => {
  it('returns only owner-scoped receipt metadata for reload verification', async () => {
    const privateReceipt = { ...original, actorKind: 'assistant' as const, turnId: TURN, reversibleFields: { title: { before: 'old', after: 'new' } }, requestFingerprint: 'private-fingerprint' };
    const getReceipt = jest.fn(async () => privateReceipt);
    const app = appWithUndo({ undo: jest.fn(), getReceipt });
    const response = await request(app).get(`/api/v1/actions/${ACTION}`).set('Cookie', '__Host-pa_session=session-token');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      id: ACTION,
      actionKind: 'workspace.create',
      actorKind: 'assistant',
      turnId: TURN,
      targetKind: 'workspace',
      targetId: '33333333-3333-4333-8333-333333333333',
      postVersion: 2,
      undoStatus: 'undone',
      undoActionId: '44444444-4444-4444-8444-444444444444'
    });
    expect(response.body.data).not.toHaveProperty('reversibleFields');
    expect(response.body.data).not.toHaveProperty('requestFingerprint');
    expect(getReceipt).toHaveBeenCalledWith({ ownerId: OWNER, actionId: ACTION });
  });

  it('requires same-origin CSRF and sends the authenticated owner plus key to the use case', async () => {
    const assistantAction = { ...original, actorKind: 'assistant' as const, turnId: TURN };
    const undo = jest.fn(async () => ({ originalAction: assistantAction, undoReceipt: assistantAction, target: null, replayed: false }));
    const app = appWithUndo({ undo });
    const blocked = await request(app).post(`/api/v1/actions/${ACTION}/undo`).set('Cookie', '__Host-pa_session=session-token').send({});
    expect(blocked.status).toBe(403);
    expect(undo).not.toHaveBeenCalled();

    const response = await request(app).post(`/api/v1/actions/${ACTION}/undo`).set(mutationHeaders()).send({ completedTaskCreateActionIds: [] });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      originalAction: { id: ACTION, actorKind: 'assistant', turnId: TURN },
      undoReceipt: { id: ACTION, actorKind: 'assistant', turnId: TURN },
      target: null,
      replayed: false
    });
    expect(undo).toHaveBeenCalledWith({ ownerId: OWNER, actionId: ACTION, operationKey: 'undo-workspace-1', completedTaskCreateActionIds: [] });
  });

  it('rejects unknown body fields and malformed action IDs before undo work', async () => {
    const undo = jest.fn(async () => ({ originalAction: original, undoReceipt: original, target: null, replayed: false }));
    const app = appWithUndo({ undo });
    const invalidBody = await request(app).post(`/api/v1/actions/${ACTION}/undo`).set(mutationHeaders()).send({ force: true });
    expect(invalidBody.status).toBe(400);
    const invalidId = await request(app).post('/api/v1/actions/not-a-uuid/undo').set(mutationHeaders()).send({});
    expect(invalidId.status).toBe(400);
    expect(undo).not.toHaveBeenCalled();
  });

  it('returns the owner-safe latest action state in the 409 envelope', async () => {
    const undo = jest.fn(async () => {
      throw new ActionUndoConflictError('changed', original, null);
    });
    const app = appWithUndo({ undo });
    const response = await request(app).post(`/api/v1/actions/${ACTION}/undo`).set(mutationHeaders()).send({});

    expect(response.status).toBe(409);
    expect(response.body.data).toMatchObject({ originalAction: { id: ACTION, actorKind: 'manual', turnId: null }, target: null, reason: 'changed' });
    expect(response.body.error.code).toBe('ACTION_UNDO_CONFLICT');
  });
});
