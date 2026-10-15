import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { GetReadinessUseCase } from '@/modules/health';
import type { GlobalTaskQueryItem } from '@/modules/tasks/domain/global-task-query';
import { encodeGlobalTaskQueryCursor } from '@/modules/tasks/domain/global-task-query-cursor';
import type { IGlobalTaskQueryRepository } from '@/modules/tasks/repositories/global-task-query-repository';
import { GetGlobalTaskUseCase, ListGlobalTasksUseCase } from '@/modules/tasks/use-cases/global-task-query-use-cases';
import { createLogger } from '@/shared/logging/logger';

const ORIGIN = 'https://127.0.0.1:8443';
const OWNER = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const HEADERS = { Cookie: '__Host-pa_session=valid' };
const IMPOSSIBLE_TIMESTAMP_CURSOR = encodeGlobalTaskQueryCursor(
  { createdAt: '2026-02-30T08:09:10.123456Z', taskId: TASK },
  OWNER,
  { inboxOnly: false, includeArchived: false, limit: 25 }
);

function taskItem(projectId: string | null): GlobalTaskQueryItem {
  const now = new Date('2026-10-16T08:09:10.123Z');
  return {
    task: {
      id: TASK,
      projectId,
      title: 'Review quarterly report',
      details: null,
      status: 'todo',
      importance: 'high',
      deadline: '2026-10-30',
      subtasks: [],
      position: 1,
      version: 2,
      source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      archivedAt: null
    },
    collection: projectId ? 'workspace' : 'inbox',
    workspace: projectId ? { id: projectId, name: 'Quarterly', status: 'active' } : null
  };
}

function fixture() {
  const listGlobalTasks = jest.fn().mockResolvedValue({ items: [taskItem(null)], hasMore: false, lastPosition: null });
  const getGlobalTask = jest.fn().mockImplementation(async (input: { readonly taskId: string }) => input.taskId === TASK ? taskItem(WORKSPACE) : null);
  const taskQuery = { listGlobalTasks, getGlobalTask } as unknown as IGlobalTaskQueryRepository;
  const getSession = { execute: jest.fn().mockImplementation(async (token: unknown) => {
    if (token !== 'valid') throw new UnauthenticatedError();
    return { sessionId: 'session', principal: { id: OWNER }, csrfToken: 'csrf', expiresAt: new Date('2099-01-01') };
  }) } as unknown as GetSessionUseCase;
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  const app = createApp({
    logger: createLogger('silent'),
    appVersion: 'test',
    readiness: new GetReadinessUseCase(readiness),
    globalTasks: {
      getSession,
      listTasks: new ListGlobalTasksUseCase(taskQuery),
      getTask: new GetGlobalTaskUseCase(taskQuery),
      clearSessionCookie: () => undefined
    }
  });
  return { app, listGlobalTasks, getGlobalTask };
}

describe('global task query API', () => {
  it('lists Inbox and workspace task data from the session owner with validated filters', async () => {
    const { app, listGlobalTasks } = fixture();
    const response = await request(app)
      .get('/api/v1/tasks?inboxOnly=true&status=todo&importance=high&deadlineFrom=2026-10-01&deadlineTo=2026-10-31&q=review%20quarterly&limit=10')
      .set(HEADERS)
      .expect(200);

    expect(response.body.data.items[0]).toMatchObject({
      collection: 'inbox',
      task: { id: TASK, projectId: null, deadline: '2026-10-30', createdAt: '2026-10-16T08:09:10.123Z' },
      workspace: null
    });
    expect(response.body.data.nextCursor).toBeNull();
    expect(listGlobalTasks).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: OWNER,
      filters: expect.objectContaining({
        inboxOnly: true,
        status: 'todo',
        importance: 'high',
        deadlineFrom: '2026-10-01',
        deadlineTo: '2026-10-31',
        q: 'review quarterly',
        limit: 10
      })
    }));
  });

  it('rejects malformed filters and cursor reuse before repository access', async () => {
    const { app, listGlobalTasks } = fixture();

    await request(app).get('/api/v1/tasks?deadlineFrom=2026-02-30').set(HEADERS).expect(400);
    await request(app).get('/api/v1/tasks?inboxOnly=true&workspaceId=' + WORKSPACE).set(HEADERS).expect(400);
    await request(app).get('/api/v1/tasks?status=archived').set(HEADERS).expect(400);
    await request(app).get('/api/v1/tasks?ownerId=' + OWNER).set(HEADERS).expect(400);
    await request(app).get('/api/v1/tasks?cursor=not-a-cursor').set(HEADERS).expect(400);

    expect(listGlobalTasks).not.toHaveBeenCalled();
  });

  it('rejects a correctly encoded impossible cursor date before repository access', async () => {
    const { app, listGlobalTasks } = fixture();

    await request(app).get(`/api/v1/tasks?cursor=${IMPOSSIBLE_TIMESTAMP_CURSOR}`).set(HEADERS).expect(400);

    expect(listGlobalTasks).not.toHaveBeenCalled();
  });

  it('requires a session and returns a stable detail response or non-disclosing 404', async () => {
    const { app, getGlobalTask } = fixture();

    await request(app).get(`/api/v1/tasks/${TASK}`).expect(401);
    const detail = await request(app).get(`/api/v1/tasks/${TASK}?includeArchived=true`).set(HEADERS).expect(200);
    expect(detail.body.data).toMatchObject({ collection: 'workspace', workspace: { id: WORKSPACE, name: 'Quarterly' }, task: { id: TASK } });
    expect(getGlobalTask).toHaveBeenCalledWith({ ownerId: OWNER, taskId: TASK, includeArchived: true });
    await request(app).get(`/api/v1/tasks/${WORKSPACE}`).set(HEADERS).expect(404);
  });
});
