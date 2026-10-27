import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';

import { createSkillRouter, type SkillRouterDependencies } from '@/modules/skills/controllers/skill-router';
import { AppError } from '@/shared/errors/app-error';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const SKILL_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://127.0.0.1:8443';

function buildApp(): { readonly app: express.Express; readonly invokeSkill: jest.Mock } {
  const invokeSkill = jest.fn(async () => ({
    invocation: {
      id: '44444444-4444-4444-8444-444444444444', skillId: SKILL_ID, skillVersion: 1,
      conversationId: CONVERSATION_ID, turnId: '55555555-5555-4555-8555-555555555555',
      contextRevisions: [{ kind: 'home_message', id: '66666666-6666-4666-8666-666666666666', revision: 4 }], state: 'running'
    }
  }));
  const dependencies = {
    getSession: { execute: jest.fn(async () => ({
      sessionId: 'session', principal: { id: OWNER_ID, displayName: 'Local user' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000)
    })) },
    listSkills: { execute: jest.fn(async () => []) },
    getSkill: { execute: jest.fn() },
    createSkill: { execute: jest.fn() },
    updateSkill: { execute: jest.fn() },
    deleteSkill: { execute: jest.fn() },
    invokeSkill: { execute: invokeSkill },
    appOrigin: ORIGIN,
    clearSessionCookie: jest.fn()
  } as unknown as SkillRouterDependencies;
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/skills', createSkillRouter(dependencies));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 500, 'Internal server error.');
    response.status(appError.statusCode).json({ data: null, error: { code: appError.code, message: appError.message } });
  });
  return { app, invokeSkill };
}

function mutationHeaders(): Record<string, string> {
  return {
    Cookie: '__Host-pa_session=session-token', Origin: ORIGIN, 'X-CSRF-Token': 'csrf-token', 'Idempotency-Key': 'invoke-001'
  };
}

describe('skill invocation route', () => {
  it('requires same-origin session and CSRF before invoking a skill', async () => {
    const { app, invokeSkill } = buildApp();
    const blocked = await request(app).post(`/api/v1/skills/${SKILL_ID}/invocations`).set('Cookie', '__Host-pa_session=session-token').send({
      conversationId: CONVERSATION_ID, expectedVersion: 1, request: 'Plan my day.'
    });
    expect(blocked.status).toBe(403);
    expect(invokeSkill).not.toHaveBeenCalled();
  });

  it('forwards the authenticated owner and idempotency header to the bounded invocation use case', async () => {
    const { app, invokeSkill } = buildApp();
    const result = await request(app).post(`/api/v1/skills/${SKILL_ID}/invocations`).set(mutationHeaders()).send({
      conversationId: CONVERSATION_ID, expectedVersion: 1, request: 'Plan my day.'
    });

    expect(invokeSkill).toHaveBeenCalled();
    expect(result.status).toBe(200);
    expect(result.body.data.invocation).toMatchObject({ skillId: SKILL_ID, conversationId: CONVERSATION_ID, state: 'running' });
    expect(invokeSkill).toHaveBeenCalledWith({
      ownerId: OWNER_ID, skillId: SKILL_ID, conversationId: CONVERSATION_ID,
      expectedVersion: 1, request: 'Plan my day.', requestKey: 'invoke-001'
    });
  });

  it('rejects unknown request fields before invocation', async () => {
    const { app, invokeSkill } = buildApp();
    const invalid = await request(app).post(`/api/v1/skills/${SKILL_ID}/invocations`).set(mutationHeaders()).send({
      conversationId: CONVERSATION_ID, expectedVersion: 1, request: 'Plan my day.', ownerId: 'attacker'
    });
    expect(invalid.status).toBe(400);
    expect(invokeSkill).not.toHaveBeenCalled();
  });
});
