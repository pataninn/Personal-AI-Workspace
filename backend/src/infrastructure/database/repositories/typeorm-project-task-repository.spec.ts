import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmProjectTaskRepository } from '@/infrastructure/database/repositories/typeorm-project-task-repository';
import { ProjectTaskVersionConflictError } from '@/modules/tasks/domain/project-task-errors';
import type { ProjectTaskStatus, ProjectTaskSubtask } from '@/modules/tasks/domain/project-task';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const SUGGESTION = '55555555-5555-4555-8555-555555555555';
const RUN = '66666666-6666-4666-8666-666666666666';
const CONVERSATION = '77777777-7777-4777-8777-777777777777';
const CHILD = { id: '44444444-4444-4444-8444-444444444444', title: 'Review', completed: false };

function fixture(currentStatus: ProjectTaskStatus, children: readonly ProjectTaskSubtask[]) {
  let reads = 0;
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM "projects"')) return [{ status: 'active' }];
    if (sql.includes('FROM "project_tasks" t')) {
      reads += 1;
      return [row(currentStatus, children, reads === 1 ? 1 : 2)];
    }
    if (sql.startsWith('UPDATE "project_tasks"')) return [[{ id: TASK }], 1];
    if (sql.startsWith('INSERT INTO "project_tasks"')) return [{ id: TASK }];
    if (sql.includes('count(*)')) return [{ count: 0 }];
    if (sql.includes('SELECT "version"')) return [{ version: 1 }];
    if (sql.startsWith('UPDATE "project_task_order_states"')) return [{ version: 2 }];
    return [];
  });
  const runner = { query, connect: jest.fn(), startTransaction: jest.fn(), commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), isTransactionActive: true };
  const dataSource = { createQueryRunner: () => runner as unknown as QueryRunner } as DataSource;
  return { repository: new TypeOrmProjectTaskRepository(dataSource), query, runner };
}

function row(status: ProjectTaskStatus, subtasks: readonly ProjectTaskSubtask[], version: number) {
  return { id: TASK, owner_id: OWNER, project_id: PROJECT, title: 'Parent', details: null,
    importance: 'medium', deadline: null, subtasks, status, version, position: 0, source_kind: 'user', source_suggestion_id: null,
    source_run_id: null, source_conversation_id: null, source_accepted_at: null,
    created_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-05T00:00:00Z', completed_at: status === 'done' ? '2026-10-05T00:00:00Z' : null, archived_at: null };
}

const INPUT = { ownerId: OWNER, projectId: PROJECT, taskId: TASK, expectedVersion: 1 };

describe('task checklist persistence boundary', () => {
  it.each([false, true])('binds the inserted parent status as the same PostgreSQL enum in VALUES and completion CASE (%s)', async (completed) => {
    const children = [{ ...CHILD, completed }];
    const { repository, query, runner } = fixture(completed ? 'done' : 'todo', children);
    await repository.createTask({ ownerId: OWNER, projectId: PROJECT, title: 'Parent', details: null, importance: 'medium', deadline: null,
      subtasks: children, idempotencyKey: 'create', requestFingerprint: 'fingerprint' });
    const insert = query.mock.calls.find(([sql]: [string]) => sql.startsWith('INSERT INTO "project_tasks"'));
    // The status parameter is reused in CASE; both occurrences must have one enum type.
    expect(insert?.[0]).toContain('$13::jsonb, $14::"project_task_status", CASE WHEN $14::"project_task_status" = \'done\'');
    expect(insert?.[1]?.[13]).toBe(completed ? 'done' : 'todo');
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('reads accepted suggestion provenance from the task snapshot instead of the mutable suggestion row', async () => {
    const { repository, query } = fixture('todo', []);
    const acceptedAt = '2026-10-05T00:01:00Z';
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "project_task_order_states"')) return [{ version: 3 }];
      if (sql.includes('FROM "project_tasks" t')) return [{
        ...row('todo', [], 1),
        source_kind: 'assistant_suggestion',
        source_suggestion_id: SUGGESTION,
        source_run_id: RUN,
        source_conversation_id: CONVERSATION,
        source_accepted_at: acceptedAt
      }];
      return [];
    });

    const snapshot = await repository.listTasks(OWNER, PROJECT, 'all');
    const taskSelect = query.mock.calls.find(([sql]: [string]) => sql.includes('FROM "project_tasks" t'));

    expect(snapshot.tasks[0]?.projectId).toBe(PROJECT);
    expect(snapshot.tasks[0]?.source).toMatchObject({
      kind: 'assistant_suggestion',
      suggestionId: SUGGESTION,
      runId: RUN,
      conversationId: CONVERSATION,
      acceptedAt: new Date(acceptedAt)
    });
    expect(taskSelect?.[0]).toContain('t."source_run_id"');
    expect(taskSelect?.[0]).not.toContain('JOIN "project_task_suggestions"');
  });

  it('writes suggestion provenance only from the owner-scoped suggestion record', async () => {
    let suggestionReads = 0;
    let taskReads = 0;
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "projects"')) return [{ status: 'active' }];
      if (sql.includes('SELECT "version" FROM "project_task_order_states"')) return [{ version: 1 }];
      if (sql.includes('FROM "project_task_suggestions" s')) {
        suggestionReads += 1;
        const accepted = suggestionReads > 1;
        return [{
          id: SUGGESTION,
          owner_id: OWNER,
          project_id: PROJECT,
          run_id: RUN,
          conversation_id: CONVERSATION,
          title: 'Suggested task',
          details: null,
          subtasks: [],
          status: accepted ? 'accepted' : 'pending',
          version: accepted ? 2 : 1,
          created_at: '2026-10-05T00:00:00Z',
          resolved_at: accepted ? '2026-10-05T00:01:00Z' : null,
          task_id: accepted ? TASK : null
        }];
      }
      if (sql.includes('count(*)')) return [{ count: 0 }];
      if (sql.startsWith('INSERT INTO "project_tasks"')) return [{ id: TASK }];
      if (sql.includes('FROM "project_tasks" t')) {
        taskReads += 1;
        return [{
          ...row('todo', [], 1),
          source_kind: 'assistant_suggestion',
          source_suggestion_id: SUGGESTION,
          source_run_id: RUN,
          source_conversation_id: CONVERSATION,
          source_accepted_at: '2026-10-05T00:01:00Z'
        }];
      }
      if (sql.startsWith('UPDATE "project_task_order_states"')) return [{ version: 2 }];
      return [];
    });
    const runner = {
      query,
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      isTransactionActive: true
    };
    const dataSource = { createQueryRunner: () => runner as unknown as QueryRunner } as DataSource;
    const repository = new TypeOrmProjectTaskRepository(dataSource);

    const result = await repository.resolveSuggestion({
      ownerId: OWNER,
      projectId: PROJECT,
      suggestionId: SUGGESTION,
      expectedVersion: 1,
      decision: 'accepted'
    });
    const insert = query.mock.calls.find(([sql]: [string]) => sql.startsWith('INSERT INTO "project_tasks"'));
    const suggestionJoin = query.mock.calls.find(([sql]: [string]) => sql.includes('LEFT JOIN "project_tasks" t'));

    expect(result.decision).toBe('accepted');
    expect(insert?.[0]).toContain('CASE WHEN $7::uuid IS NOT NULL THEN now() ELSE NULL END');
    expect(insert?.[1]?.slice(6, 10)).toEqual([SUGGESTION, PROJECT, RUN, CONVERSATION]);
    expect(suggestionJoin?.[0]).toContain('t."owner_id" = s."owner_id"');
    expect(suggestionJoin?.[0]).toContain('t."source_suggestion_project_id" = s."project_id"');
    expect(taskReads).toBe(2);
  });

  it('maps an owner-scoped accepted task currently in Inbox to a null projectId', async () => {
    const acceptedAt = '2026-10-05T00:01:00Z';
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "projects"')) return [{ status: 'active' }];
      if (sql.includes('FROM "project_task_order_states"')) return [{ version: 4 }];
      if (sql.includes('FROM "project_task_suggestions" s')) return [{
        id: SUGGESTION,
        owner_id: OWNER,
        project_id: PROJECT,
        run_id: RUN,
        conversation_id: CONVERSATION,
        title: 'Suggested task',
        details: null,
        subtasks: [],
        status: 'accepted',
        version: 2,
        created_at: '2026-10-05T00:00:00Z',
        resolved_at: acceptedAt,
        task_id: TASK
      }];
      if (sql.includes('source_suggestion_project_id')) return [{
        ...row('todo', [], 2),
        project_id: null,
        source_kind: 'assistant_suggestion',
        source_suggestion_id: SUGGESTION,
        source_run_id: RUN,
        source_conversation_id: CONVERSATION,
        source_accepted_at: acceptedAt
      }];
      return [];
    });
    const runner = {
      query,
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      isTransactionActive: true
    };
    const dataSource = { createQueryRunner: () => runner as unknown as QueryRunner } as DataSource;
    const repository = new TypeOrmProjectTaskRepository(dataSource);

    const result = await repository.resolveSuggestion({
      ownerId: OWNER,
      projectId: PROJECT,
      suggestionId: SUGGESTION,
      expectedVersion: 2,
      decision: 'accepted'
    });
    const taskLookup = query.mock.calls.find(([sql]: [string]) => sql.includes('WHERE t."owner_id" = $1 AND t."source_suggestion_project_id"'));

    expect(result.decision).toBe('accepted');
    if (result.decision === 'accepted') {
      expect(result.task.projectId).toBeNull();
      expect(result.task.source.suggestionId).toBe(SUGGESTION);
    }
    expect(taskLookup?.[0]).toContain('WHERE t."owner_id" = $1 AND t."source_suggestion_project_id" = $2 AND t."source_suggestion_id" = $3');
    expect(taskLookup?.[1]).toEqual([OWNER, PROJECT, SUGGESTION]);
  });
  it('stores manual parent completion and checked children in the same versioned update', async () => {
    const { repository, query, runner } = fixture('todo', [CHILD]);
    await repository.updateTask({ ...INPUT, status: 'done' });
    const update = query.mock.calls.find(([sql]: [string]) => sql.startsWith('UPDATE "project_tasks"'));
    expect(update?.[0]).toContain('"completed_at" = COALESCE("completed_at", now())');
    expect(update?.[0]).toContain('"subtasks" = $2::jsonb');
    expect(update?.[1]).toEqual(['done', JSON.stringify([{ ...CHILD, completed: true }]), OWNER, PROJECT, TASK, 1]);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('clears completion time and reopens the parent atomically when a child is unchecked', async () => {
    const { repository, query } = fixture('done', [{ ...CHILD, completed: true }]);
    await repository.updateTask({ ...INPUT, text: { subtasks: [CHILD] } });
    const update = query.mock.calls.find(([sql]: [string]) => sql.startsWith('UPDATE "project_tasks"'));
    expect(update?.[0]).toContain('"completed_at" = NULL');
    expect(update?.[1]).toEqual(['todo', JSON.stringify([CHILD]), OWNER, PROJECT, TASK, 1]);
    const event = query.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO "project_task_events"'));
    expect(event?.[1]).toEqual([OWNER, PROJECT, TASK, null, null, 'task.status_changed', JSON.stringify({ from: 'done', to: 'todo' })]);
  });

  it('automatically stores done and checked children when the last item is checked', async () => {
    const { repository, query } = fixture('blocked', [CHILD]);
    const children = [{ ...CHILD, completed: true }];
    await repository.updateTask({ ...INPUT, text: { subtasks: children } });
    const update = query.mock.calls.find(([sql]: [string]) => sql.startsWith('UPDATE "project_tasks"'));
    expect(update?.[1]).toEqual(['done', JSON.stringify(children), OWNER, PROJECT, TASK, 1]);
    expect(update?.[0]).toContain('"completed_at" = COALESCE("completed_at", now())');
  });

  it('rolls back stale checklist updates without changing the parent or children', async () => {
    const { repository, query, runner } = fixture('done', [{ ...CHILD, completed: true }]);
    await expect(repository.updateTask({ ...INPUT, expectedVersion: 2, text: { subtasks: [CHILD] } })).rejects.toBeInstanceOf(ProjectTaskVersionConflictError);
    expect(query.mock.calls.some(([sql]: [string]) => sql.startsWith('UPDATE "project_tasks"'))).toBe(false);
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
  });
});
