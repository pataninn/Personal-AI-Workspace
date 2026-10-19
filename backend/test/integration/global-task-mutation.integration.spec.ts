import request from 'supertest';

import { createApp } from '@/app';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { GetReadinessUseCase } from '@/modules/health';
import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';
import type { GlobalTaskQueryItem } from '@/modules/tasks/domain/global-task-query';
import type { IGlobalTaskQueryRepository } from '@/modules/tasks/repositories/global-task-query-repository';
import { CountInboxTasksUseCase, GetGlobalTaskUseCase, ListGlobalTasksUseCase } from '@/modules/tasks/use-cases/global-task-query-use-cases';
import type { ITaskMutationCommands, TaskMutationCommandResult } from '@/modules/tasks/use-cases/task-mutation-use-cases';
import { createLogger } from '@/shared/logging/logger';

const ORIGIN = 'https://127.0.0.1:8443';
const OWNER = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const HEADERS = { Cookie: '__Host-pa_session=valid', Origin: ORIGIN, 'X-CSRF-Token': 'csrf' };

function item(projectId: string | null, version = 2): GlobalTaskQueryItem {
  const now = new Date('2026-10-16T08:09:10.123Z');
  return {
    task: {
      id: TASK,
      projectId,
      title: 'Review quarterly report',
      details: null,
      status: 'todo',
      importance: 'medium',
      deadline: null,
      subtasks: [],
      position: 0,
      version,
      source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
      createdAt: now,
      updatedAt: now,
      completedAt: null
    },
    collection: projectId ? 'workspace' : 'inbox',
    workspace: projectId ? { id: projectId, name: 'Quarterly', status: 'active' } : null
  };
}

function commandResult(actionKind: ActionLedgerRecord['actionKind'], projectId: string | null): TaskMutationCommandResult {
  return {
    item: item(projectId),
    replayed: false,
    receipt: {
      id: '44444444-4444-4444-8444-444444444444',
      ownerId: OWNER,
      operationKey: 'web-key',
      requestFingerprint: 'fingerprint',
      actorKind: 'manual',
      turnId: null,
      targetKind: 'task',
      targetId: TASK,
      actionKind,
      expectedVersion: actionKind === 'task.create' ? null : 1,
      preVersion: actionKind === 'task.create' ? null : 1,
      postVersion: 2,
      reversibleFields: {},
      outcome: { targetId: TASK, targetVersion: 2, sourceOrderVersion: 2, destinationOrderVersion: 2 },
      undoStatus: 'available',
      undoOfActionId: null,
      undoActionId: null,
      createdAt: '2026-10-16T08:09:10.123Z'
    }
  };
}

function fixture() {
  const taskQuery = {
    countInboxTasks: jest.fn().mockResolvedValue(0),
    listGlobalTasks: jest.fn().mockResolvedValue({ items: [], hasMore: false, lastPosition: null }),
    getGlobalTask: jest.fn().mockResolvedValue(item(null))
  } as unknown as IGlobalTaskQueryRepository;
  const getSession = {
    execute: jest.fn().mockImplementation(async (token: unknown) => {
      if (token !== 'valid') throw new UnauthenticatedError();
      return { sessionId: 'session', principal: { id: OWNER }, csrfToken: 'csrf', expiresAt: new Date('2099-01-01') };
    })
  } as unknown as GetSessionUseCase;
  const mutations = {
    create: jest.fn().mockResolvedValue(commandResult('task.create', null)),
    update: jest.fn().mockResolvedValue(commandResult('task.update', null)),
    move: jest.fn().mockResolvedValue(commandResult('task.move', WORKSPACE)),
    delete: jest.fn().mockResolvedValue({
      taskId: TASK,
      orderVersion: 3,
      replayed: false,
      receipt: {
        ...commandResult('task.delete', null).receipt,
        actionKind: 'task.delete',
        postVersion: null,
        outcome: { targetId: TASK, targetVersion: null, sourceOrderVersion: 3 },
        undoStatus: 'not_reversible'
      }
    })
  } as unknown as ITaskMutationCommands;
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  const app = createApp({
    logger: createLogger('silent'),
    appVersion: 'test',
    readiness: new GetReadinessUseCase(readiness),
    globalTasks: {
      getSession,
      countInboxTasks: new CountInboxTasksUseCase(taskQuery),
      listTasks: new ListGlobalTasksUseCase(taskQuery),
      getTask: new GetGlobalTaskUseCase(taskQuery),
      mutations,
      appOrigin: ORIGIN,
      clearSessionCookie: () => undefined
    }
  });
  return { app, mutations };
}

describe('global task mutation API', () => {
  it('routes create, patch, move, and canonical deletion through owner-derived commands and returns stable receipts', async () => {
    const { app, mutations } = fixture();

    const created = await request(app)
      .post('/api/v1/tasks')
      .set({ ...HEADERS, 'Idempotency-Key': 'create-once' })
      .send({ title: 'Draft', workspaceId: null })
      .expect(201);
    expect(created.headers.location).toBe(`/api/v1/tasks/${TASK}`);
    expect(created.headers.etag).toBe('"2"');
    expect(created.body.data).toMatchObject({ item: { task: { id: TASK, projectId: null } }, receipt: { actionKind: 'task.create' }, replayed: false });
    expect(mutations.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, operationKey: 'create-once', projectId: null, title: 'Draft' }));

    const updated = await request(app)
      .patch(`/api/v1/tasks/${TASK}`)
      .set({ ...HEADERS, 'Idempotency-Key': 'clear-details', 'If-Match': '"2"' })
      .send({ details: null })
      .expect(200);
    expect(updated.headers.etag).toBe('"2"');
    expect(mutations.update).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, taskId: TASK, expectedVersion: 2, operationKey: 'clear-details', details: null }));

    await request(app)
      .post(`/api/v1/tasks/${TASK}/move`)
      .set({ ...HEADERS, 'Idempotency-Key': 'move-once', 'If-Match': '"2"' })
      .send({ workspaceId: WORKSPACE, expectedSourceOrderVersion: 4, expectedDestinationOrderVersion: 8 })
      .expect(200);
    expect(mutations.move).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, taskId: TASK, workspaceId: WORKSPACE, expectedVersion: 2, expectedSourceOrderVersion: 4, expectedDestinationOrderVersion: 8 }));

    const deleted = await request(app)
      .delete(`/api/v1/tasks/${TASK}`)
      .set({ ...HEADERS, 'Idempotency-Key': 'delete-once', 'If-Match': '"2"' })
      .expect(200);
    expect(deleted.headers.etag).toBe('"3"');
    expect(deleted.body.data).toMatchObject({
      taskId: TASK, orderVersion: 3,
      receipt: {
        actionKind: 'task.delete', undoStatus: 'not_reversible',
        outcome: { targetId: TASK, targetVersion: null, sourceOrderVersion: 3 }
      },
      replayed: false
    });
    expect(deleted.body.data.item).toBeUndefined();
    expect(mutations.delete).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, taskId: TASK, expectedVersion: 2, operationKey: 'delete-once' }));
    await request(app).post(`/api/v1/tasks/${TASK}/archive`).set({ ...HEADERS, 'Idempotency-Key': 'archive-once', 'If-Match': '"2"' }).expect(404);
  });

  it('rejects missing mutation guards and caller-supplied owner data before the command boundary', async () => {
    const { app, mutations } = fixture();

    await request(app).post('/api/v1/tasks').set(HEADERS).send({ title: 'No key' }).expect(400);
    await request(app).patch(`/api/v1/tasks/${TASK}`).set({ ...HEADERS, 'Idempotency-Key': 'no-version' }).send({ title: 'Changed' }).expect(428);
    await request(app).post('/api/v1/tasks').set({ ...HEADERS, 'Idempotency-Key': 'owner-smuggle' }).send({ title: 'Draft', ownerId: OWNER }).expect(400);
    await request(app).post('/api/v1/tasks').set({ Cookie: HEADERS.Cookie, Origin: ORIGIN, 'Idempotency-Key': 'no-csrf' }).send({ title: 'Draft' }).expect(403);

    expect(mutations.create).not.toHaveBeenCalled();
    expect(mutations.update).not.toHaveBeenCalled();
  });
});
