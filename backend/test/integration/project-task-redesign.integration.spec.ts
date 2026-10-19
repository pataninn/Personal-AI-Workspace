import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { GetReadinessUseCase } from '@/modules/health';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IProjectTaskRepository, CreateProjectTaskRecord } from '@/modules/tasks/repositories/project-task-repository';
import type { ProjectTask } from '@/modules/tasks/domain/project-task';
import { CreateProjectTaskUseCase, ListProjectTasksUseCase, ListProjectTaskSuggestionsUseCase, ReorderProjectTaskUseCase, ResolveProjectTaskSuggestionUseCase, UpdateProjectTaskUseCase } from '@/modules/tasks';
import { createLogger } from '@/shared/logging/logger';

const ORIGIN = 'https://127.0.0.1:8443';
const OWNER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const PATH = `/api/v1/projects/${PROJECT}/tasks`;
const HEADERS = { Origin: ORIGIN, Cookie: '__Host-pa_session=valid', 'X-CSRF-Token': 'csrf' };

function fixture(): { app: express.Express; createTask: jest.Mock } {
  const projects = { findByIdForOwner: jest.fn().mockImplementation(async (owner: string, project: string) => owner === OWNER && project === PROJECT ? { status: 'active' } : null) } as unknown as IProjectRepository;
  const createTask = jest.fn().mockImplementation(async (input: CreateProjectTaskRecord) => ({ task: makeTask(input), orderVersion: 2, replayed: false }));
  const tasks = { createTask, listTasks: jest.fn(), updateTask: jest.fn(), reorderTask: jest.fn(), listSuggestions: jest.fn(), resolveSuggestion: jest.fn() } as unknown as IProjectTaskRepository;
  const getSession = { execute: jest.fn().mockImplementation(async (token: unknown) => {
    if (token !== 'valid') throw new UnauthenticatedError();
    return { sessionId: 'session', principal: { id: OWNER }, csrfToken: 'csrf', expiresAt: new Date('2099-01-01') };
  }) } as unknown as GetSessionUseCase;
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  const app = createApp({ logger: createLogger('silent'), appVersion: 'test', readiness: new GetReadinessUseCase(readiness), projectTasks: {
    getSession, appOrigin: ORIGIN, clearSessionCookie: () => undefined,
    createTask: new CreateProjectTaskUseCase(projects, tasks),
    updateTask: new UpdateProjectTaskUseCase(projects, tasks), listTasks: new ListProjectTasksUseCase(projects, tasks),
    reorderTask: new ReorderProjectTaskUseCase(projects, tasks), listSuggestions: new ListProjectTaskSuggestionsUseCase(projects, tasks),
    resolveSuggestion: new ResolveProjectTaskSuggestionUseCase(projects, tasks)
  } });
  return { app, createTask };
}

function makeTask(input: CreateProjectTaskRecord): ProjectTask {
  const now = new Date('2026-10-05T00:00:00Z');
  return { id: TASK, projectId: PROJECT, title: input.title, details: input.details, importance: input.importance, deadline: input.deadline, subtasks: input.subtasks,
    status: 'todo', position: 0, version: 1, source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null }, createdAt: now, updatedAt: now, completedAt: null };
}

describe('task redesign API boundary', () => {
  it('creates tasks with scheduling/checklist fields and server-generated checklist ids', async () => {
    const { app, createTask } = fixture();
    const response = await request(app).post(PATH).set(HEADERS).set('Idempotency-Key', 'create').send({ title: 'Review', importance: 'high', deadline: '2028-02-29', subtasks: [{ title: ' First ' }] }).expect(201);
    expect(response.body.data.task).toMatchObject({ importance: 'high', deadline: '2028-02-29', subtasks: [{ title: 'First', completed: false }] });
    expect(response.body.data.task.subtasks[0].id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, projectId: PROJECT }));
  });

  it('rejects impossible calendar dates and nested subtasks before persistence', async () => {
    const { app, createTask } = fixture();
    for (const changes of [{ deadline: '2026-02-29' }, { subtasks: [{ title: 'Child', subtasks: [{ title: 'Nested' }] }] }]) {
      await request(app).post(PATH).set(HEADERS).set('Idempotency-Key', 'create').send({ title: 'Review', ...changes }).expect(400);
    }
    expect(createTask).not.toHaveBeenCalled();
  });

  it('removes the nested delete route so assigned tasks use the canonical global task path', async () => {
    const { app } = fixture();
    await request(app).delete(`${PATH}/${TASK}`).set(HEADERS).set('If-Match', '"1"').expect(404);
  });

  it('removes the archive mutation and denies writes to another project', async () => {
    const { app, createTask } = fixture();
    await request(app).patch(`${PATH}/${TASK}`).set(HEADERS).set('If-Match', '"1"').send({ status: 'archived' }).expect(400);
    await request(app).post('/api/v1/projects/44444444-4444-4444-8444-444444444444/tasks').set(HEADERS).set('Idempotency-Key', 'create').send({ title: 'Review' }).expect(404);
    expect(createTask).not.toHaveBeenCalled();
  });
});
