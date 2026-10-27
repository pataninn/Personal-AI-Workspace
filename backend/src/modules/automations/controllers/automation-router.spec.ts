import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';

import { createAutomationRouter, type AutomationRouterDependencies } from '@/modules/automations/controllers/automation-router';
import { AppError } from '@/shared/errors/app-error';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const SKILL_ID = '44444444-4444-4444-8444-444444444444';
const ORIGIN = 'https://127.0.0.1:8443';

function buildApp() {
  const createSchedule = { execute: jest.fn(async () => ({ schedule: schedule(), replayed: false })) };
  const listSchedules = { execute: jest.fn(async () => [schedule()]) };
  const updateSchedule = { execute: jest.fn(async () => schedule({ enabled: false, revision: 2 })) };
  const runNow = { execute: jest.fn(async () => ({ occurrence: occurrence(), replayed: false })) };
  const listOccurrences = { execute: jest.fn(async () => ({ occurrences: [occurrence()], nextCursor: null })) };
  const dependencies = {
    getSession: { execute: jest.fn(async () => ({
      sessionId: 'session-id', principal: { id: OWNER_ID, displayName: 'Local user' },
      csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000)
    })) },
    createSchedule, listSchedules, updateSchedule, runNow, listOccurrences,
    appOrigin: ORIGIN, clearSessionCookie: jest.fn()
  } as unknown as AutomationRouterDependencies;
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/automations', createAutomationRouter(dependencies));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 500, 'Internal server error.');
    response.status(appError.statusCode).json({ data: null, error: { code: appError.code, message: appError.message } });
  });
  return { app, createSchedule, listSchedules, updateSchedule, runNow, listOccurrences };
}

function mutationHeaders(): Record<string, string> {
  return { Cookie: '__Host-pa_session=session-token', Origin: ORIGIN, 'X-CSRF-Token': 'csrf-token', 'Idempotency-Key': 'automation-create-001' };
}

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULE_ID, ownerId: OWNER_ID, workspaceId: WORKSPACE_ID, conversationId: '55555555-5555-4555-8555-555555555555',
    skillId: SKILL_ID, skillRevisionId: '66666666-6666-4666-8666-666666666666', skillVersion: 1,
    localTime: '08:30', timeZone: 'Asia/Shanghai', enabled: true, revision: 1, nextDueAt: new Date('2026-10-20T00:30:00Z'),
    lastRunStatus: null, createdAt: new Date('2026-10-19T00:00:00Z'), updatedAt: new Date('2026-10-19T00:00:00Z'),
    ...overrides
  };
}

function occurrence() {
  return {
    id: '77777777-7777-4777-8777-777777777777', ownerId: OWNER_ID, scheduleId: SCHEDULE_ID,
    kind: 'manual' as const, intendedFor: new Date('2026-10-19T00:00:00Z'), localDate: '2026-10-19',
    status: 'queued' as const, scheduleRevision: 1, skillVersion: 1, skillRevisionId: '66666666-6666-4666-8666-666666666666',
    homeTurnId: null, attemptCount: 0, failureCode: null, claimedUntil: null,
    createdAt: new Date('2026-10-19T00:00:00Z'), updatedAt: new Date('2026-10-19T00:00:00Z')
  };
}

describe('automation routes', () => {
  it('derives the schedule owner from the authenticated session and enforces CSRF', async () => {
    const { app, createSchedule } = buildApp();
    const blocked = await request(app).post('/api/v1/automations/schedules').set('Cookie', '__Host-pa_session=session-token').send({
      workspaceId: WORKSPACE_ID, skillId: SKILL_ID, skillVersion: 1, localTime: '08:30', timeZone: 'Asia/Shanghai'
    });
    expect(blocked.status).toBe(403);
    expect(createSchedule.execute).not.toHaveBeenCalled();

    const result = await request(app).post('/api/v1/automations/schedules').set(mutationHeaders()).send({
      workspaceId: WORKSPACE_ID, skillId: SKILL_ID, skillVersion: 1, localTime: '08:30', timeZone: 'Asia/Shanghai', ownerId: 'attacker'
    });
    expect(result.status).toBe(400);
    expect(createSchedule.execute).not.toHaveBeenCalled();
  });

  it('creates a bounded schedule and omits private owner, skill revision, and prompt data', async () => {
    const { app, createSchedule } = buildApp();
    const result = await request(app).post('/api/v1/automations/schedules').set(mutationHeaders()).send({
      workspaceId: WORKSPACE_ID, skillId: SKILL_ID, skillVersion: 1, localTime: '08:30', timeZone: 'Asia/Shanghai'
    });
    expect(result.status).toBe(201);
    expect(result.body.data.schedule).toMatchObject({ id: SCHEDULE_ID, workspaceId: WORKSPACE_ID, localTime: '08:30', revision: 1 });
    expect(result.body.data.schedule).not.toHaveProperty('ownerId');
    expect(result.body.data.schedule).not.toHaveProperty('skillRevisionId');
    expect(createSchedule.execute).toHaveBeenCalledWith({
      ownerId: OWNER_ID, idempotencyKey: 'automation-create-001', workspaceId: WORKSPACE_ID,
      skillId: SKILL_ID, skillVersion: 1, localTime: '08:30', timeZone: 'Asia/Shanghai'
    });
  });

  it('queues an idempotent Run now occurrence and validates the cursor page', async () => {
    const { app, runNow, listOccurrences } = buildApp();
    const queued = await request(app).post(`/api/v1/automations/schedules/${SCHEDULE_ID}/runs`).set(mutationHeaders()).send({});
    expect(queued.status).toBe(202);
    expect(runNow.execute).toHaveBeenCalledWith({ ownerId: OWNER_ID, scheduleId: SCHEDULE_ID, idempotencyKey: 'automation-create-001' });

    const page = await request(app).get(`/api/v1/automations/schedules/${SCHEDULE_ID}/occurrences?limit=12`)
      .set('Cookie', '__Host-pa_session=session-token');
    expect(page.status).toBe(200);
    expect(listOccurrences.execute).toHaveBeenCalledWith({ ownerId: OWNER_ID, scheduleId: SCHEDULE_ID, limit: 12 });
    const invalid = await request(app).get(`/api/v1/automations/schedules/${SCHEDULE_ID}/occurrences?limit=1000`)
      .set('Cookie', '__Host-pa_session=session-token');
    expect(invalid.status).toBe(400);
  });

  it('hides the Home result link for a confirmed pre-send budget skip', async () => {
    const { app, listOccurrences } = buildApp();
    listOccurrences.execute.mockResolvedValueOnce({
      occurrences: [{
        ...occurrence(),
        status: 'skipped',
        homeTurnId: '88888888-8888-4888-8888-888888888888',
        failureCode: 'BUDGET_EXHAUSTED',
        providerUsage: { state: 'not_started', calls: [] }
      } as never],
      nextCursor: null
    } as never);

    const page = await request(app).get(`/api/v1/automations/schedules/${SCHEDULE_ID}/occurrences`)
      .set('Cookie', '__Host-pa_session=session-token');

    expect(page.status).toBe(200);
    expect(page.body.data.occurrences[0]).toMatchObject({
      status: 'skipped',
      failureCode: 'BUDGET_EXHAUSTED',
      homeTurnId: null,
      providerUsage: { state: 'not_started', calls: [] }
    });
  });
});
