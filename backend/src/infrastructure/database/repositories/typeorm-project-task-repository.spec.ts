import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmProjectTaskRepository } from '@/infrastructure/database/repositories/typeorm-project-task-repository';
import type { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { ActionLedgerTargetStateConflictError } from '@/modules/action-ledger/domain/action-ledger-errors';
import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';
import { ProjectTaskVersionConflictError } from '@/modules/tasks/domain/project-task-errors';
import type { ProjectTaskStatus, ProjectTaskSubtask } from '@/modules/tasks/domain/project-task';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const SUGGESTION = '55555555-5555-4555-8555-555555555555';
const RUN = '66666666-6666-4666-8666-666666666666';
const CONVERSATION = '77777777-7777-4777-8777-777777777777';
const CHILD = { id: '44444444-4444-4444-8444-444444444444', title: 'Review', completed: false };

const passThroughStorageAccounting = {
  runMutation: async <T>(_transaction: unknown, _ownerId: string, mutation: () => Promise<T>): Promise<T> => mutation()
} as unknown as TypeOrmStorageContentAccounting;

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
  return { repository: new TypeOrmProjectTaskRepository(dataSource, passThroughStorageAccounting), query, runner };
}

function row(status: ProjectTaskStatus, subtasks: readonly ProjectTaskSubtask[], version: number) {
  return { id: TASK, owner_id: OWNER, project_id: PROJECT, title: 'Parent', details: null,
    importance: 'medium', deadline: null, subtasks, status, version, position: 0, source_kind: 'user', source_suggestion_id: null,
    source_run_id: null, source_conversation_id: null, source_accepted_at: null,
    created_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-05T00:00:00Z', completed_at: status === 'done' ? '2026-10-05T00:00:00Z' : null,
    completed_at_exact: status === 'done' ? '2026-10-05T00:00:00.000000Z' : null,
    archived_at: null, archived_at_exact: null };
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
    const repository = new TypeOrmProjectTaskRepository(dataSource, passThroughStorageAccounting);

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
    const repository = new TypeOrmProjectTaskRepository(dataSource, passThroughStorageAccounting);

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

describe('task action undo participants', () => {
  it('records the created task position in immutable creation event details', async () => {
    const created = row('todo', [], 1);
    let creationEventValues: readonly unknown[] | undefined;
    const query = jest.fn().mockImplementation(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('FROM "projects"')) return [{ status: 'active' }];
      if (sql.startsWith('INSERT INTO "project_task_order_states"')) return [];
      if (sql.includes('FROM "project_task_order_states"')) return [{ version: 1 }];
      if (sql.includes('count(*) AS "count"')) return [{ count: 0 }];
      if (sql.startsWith('INSERT INTO "project_tasks"')) return [{ id: TASK }];
      if (sql.includes('FROM "project_tasks" t')) return [created];
      if (sql.startsWith('INSERT INTO "project_task_events"')) {
        creationEventValues = values;
        return [];
      }
      if (sql.startsWith('UPDATE "project_task_order_states"')) return [{ version: 2 }];
      return [];
    });
    const { repository } = fixture('todo', []);

    await repository.createInTransaction({ query } as unknown as QueryRunner, {
      ownerId: OWNER, taskId: TASK, projectId: PROJECT, title: 'Child', details: null, importance: 'medium', deadline: null,
      subtasks: [], actorKind: 'manual'
    });

    expect(creationEventValues?.[5]).toBe('task.created');
    expect(JSON.parse(String(creationEventValues?.[6]))).toMatchObject({ sourceKind: 'user', position: 0 });
  });

  it('captures exact PostgreSQL completion microseconds in a done-to-todo receipt', async () => {
    const before = { ...row('done', [], 1), completed_at: '2026-10-15T12:00:00.123Z', completed_at_exact: '2026-10-15T12:00:00.123456Z' };
    const after = { ...row('todo', [], 2), completed_at: null, completed_at_exact: null };
    let taskRead = 0;
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "project_tasks" t')) {
        taskRead += 1;
        return [taskRead <= 2 ? before : after];
      }
      if (sql.includes('FROM "projects"')) return [{ status: 'active' }];
      if (sql.startsWith('UPDATE "project_tasks"')) return [{ id: TASK }];
      if (sql.includes('FROM "project_task_order_states"')) return [{ version: 8 }];
      return [];
    });
    const { repository } = fixture('todo', []);
    const runner = { query } as unknown as QueryRunner;

    const receipt = await repository.updateInTransaction(runner, {
      ownerId: OWNER,
      taskId: TASK,
      expectedVersion: 1,
      status: 'todo',
      actorKind: 'manual'
    });

    expect(receipt.reversibleFields).toMatchObject({
      status: { before: 'done', after: 'todo' },
      completedAt: { before: '2026-10-15T12:00:00.123456Z', after: null }
    });
  });

  it('restores the exact completion timestamp on undo and rejects legacy done before-images without it', async () => {
    const original: ActionLedgerRecord = {
      id: '88888888-8888-4888-8888-888888888888', ownerId: OWNER, operationKey: 'task-update', requestFingerprint: 'fp',
      actorKind: 'manual', turnId: null, targetKind: 'task', targetId: TASK, actionKind: 'task.update', expectedVersion: 1,
      preVersion: 1, postVersion: 2,
      reversibleFields: {
        status: { before: 'done', after: 'todo' },
        completedAt: { before: '2026-10-15T12:00:00.123456Z', after: null }
      },
      outcome: { targetId: TASK, targetVersion: 2, sourceOrderVersion: 8 }, undoStatus: 'available', undoOfActionId: null,
      undoActionId: null, createdAt: '2026-10-15T12:00:01.000Z'
    };
    const current = { ...row('todo', [], 2), completed_at: null, completed_at_exact: null };
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "project_tasks" t')) return [current];
      if (sql.includes('FROM "projects"')) return [{ status: 'active' }];
      if (sql.startsWith('INSERT INTO "project_task_order_states"')) return [];
      if (sql.includes('FROM "project_task_order_states"')) return [{ version: 11 }];
      if (sql.startsWith('UPDATE "project_tasks"')) return [{ version: 3 }];
      return [];
    });
    const { repository } = fixture('todo', []);
    const runner = { query } as unknown as QueryRunner;

    await repository.undoTaskInTransaction(runner, { ownerId: OWNER, original });

    const restore = query.mock.calls.find(([sql]: [string]) => sql.startsWith('UPDATE "project_tasks"'));
    expect(restore?.[0]).toContain('"completed_at" = $2::timestamptz');
    expect(restore?.[1]).toEqual(['done', '2026-10-15T12:00:00.123456Z', OWNER, TASK, 2]);

    const legacy = { ...original, reversibleFields: { status: { before: 'done', after: 'todo' } } } as ActionLedgerRecord;
    const legacyQuery = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "project_tasks" t')) return [current];
      if (sql.includes('FROM "projects"')) return [{ status: 'active' }];
      if (sql.startsWith('INSERT INTO "project_task_order_states"')) return [];
      if (sql.includes('FROM "project_task_order_states"')) return [{ version: 11 }];
      return [];
    });
    const legacyRepository = fixture('todo', []).repository;
    await expect(legacyRepository.undoTaskInTransaction({ query: legacyQuery } as unknown as QueryRunner, { ownerId: OWNER, original: legacy }))
      .rejects.toMatchObject({ reason: 'missing_reversal_data' });
    expect(legacyQuery.mock.calls.some(([sql]: [string]) => sql.startsWith('UPDATE "project_tasks"'))).toBe(false);
  });

  it('undoes a created child after later sibling creation and compensation when its recorded position is unchanged', async () => {
    const original: ActionLedgerRecord = {
      id: '88888888-8888-4888-8888-888888888888', ownerId: OWNER, operationKey: 'task-create', requestFingerprint: 'fp',
      actorKind: 'manual', turnId: null, targetKind: 'task', targetId: TASK, actionKind: 'task.create', expectedVersion: null,
      preVersion: null, postVersion: 1, reversibleFields: {},
      outcome: { targetId: TASK, targetVersion: 1, destinationOrderVersion: 2 }, undoStatus: 'available', undoOfActionId: null,
      undoActionId: null, createdAt: '2026-10-15T12:00:01.000Z'
    };
    const current = { ...row('todo', [], 1), position: 0 };
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "project_tasks" t')) return [current];
      if (sql.includes('FROM "projects"')) return [{ status: 'active' }];
      if (sql.startsWith('INSERT INTO "project_task_order_states"')) return [];
      if (sql.includes('FROM "project_task_order_states"')) return [{ version: 4 }];
      if (sql.includes('created_position')) return [{ project_id: PROJECT, created_position: '0', created_count: 1 }];
      if (sql.startsWith('UPDATE "project_tasks" SET "status" = \'archived\'')) return [{ version: 2 }];
      if (sql.includes('max(t."position")')) return [{ max_position: 1 }];
      if (sql.includes('count(*) AS "count"')) return [{ count: 1 }];
      if (sql.startsWith('UPDATE "project_task_order_states"')) return [{ version: 6 }];
      return [];
    });
    const { repository } = fixture('todo', []);

    const result = await repository.undoTaskInTransaction({ query } as unknown as QueryRunner, { ownerId: OWNER, original });

    expect(result).toMatchObject({ preVersion: 1, postVersion: 2, outcome: { targetId: TASK, targetVersion: 2, sourceOrderVersion: 6 } });
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('destinationOrderVersion'))).toBe(false);

    const movedPosition = { ...current, position: 1 };
    const changedQuery = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "project_tasks" t')) return [movedPosition];
      if (sql.includes('FROM "projects"')) return [{ status: 'active' }];
      if (sql.startsWith('INSERT INTO "project_task_order_states"')) return [];
      if (sql.includes('FROM "project_task_order_states"')) return [{ version: 4 }];
      if (sql.includes('created_position')) return [{ project_id: PROJECT, created_position: '0', created_count: 1 }];
      return [];
    });
    await expect(repository.undoTaskInTransaction({ query: changedQuery } as unknown as QueryRunner, { ownerId: OWNER, original }))
      .rejects.toMatchObject({ reason: 'missing_reversal_data' });
    expect(changedQuery.mock.calls.some(([sql]: [string]) => sql.startsWith('UPDATE "project_tasks"'))).toBe(false);
  });

  it('restores changed task fields for task.update and increments from the current version', async () => {
    const original: ActionLedgerRecord = {
      id: '88888888-8888-4888-8888-888888888888', ownerId: OWNER, operationKey: 'task-update', requestFingerprint: 'fp',
      actorKind: 'manual', turnId: null, targetKind: 'task', targetId: TASK, actionKind: 'task.update', expectedVersion: 1,
      preVersion: 1, postVersion: 2,
      reversibleFields: { title: { before: 'Before', after: 'After' } },
      outcome: { targetId: TASK, targetVersion: 2, sourceOrderVersion: 8 }, undoStatus: 'available', undoOfActionId: null,
      undoActionId: null, createdAt: '2026-10-15T12:00:01.000Z'
    };
    const current = { ...row('todo', [], 2), title: 'After' };
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "project_tasks" t')) return [current];
      if (sql.includes('FROM "projects"')) return [{ status: 'active' }];
      if (sql.includes('FROM "project_task_order_states"')) return [{ version: 8 }];
      if (sql.startsWith('UPDATE "project_tasks" SET "title"')) return [{ version: 3 }];
      return [];
    });
    const { repository } = fixture('todo', []);

    const result = await repository.undoTaskInTransaction({ query } as unknown as QueryRunner, { ownerId: OWNER, original });

    const restore = query.mock.calls.find(([sql]: [string]) => sql.startsWith('UPDATE "project_tasks" SET "title"'));
    expect(restore?.[1]).toEqual(['Before', OWNER, TASK, 2]);
    expect(result).toMatchObject({ preVersion: 2, postVersion: 3, outcome: { targetId: TASK, targetVersion: 3 } });
  });

  it('moves a task back to its recorded source collection without restoring its old version', async () => {
    const destination = '99999999-9999-4999-8999-999999999999';
    const original: ActionLedgerRecord = {
      id: '88888888-8888-4888-8888-888888888888', ownerId: OWNER, operationKey: 'task-move', requestFingerprint: 'fp',
      actorKind: 'manual', turnId: null, targetKind: 'task', targetId: TASK, actionKind: 'task.move', expectedVersion: 1,
      preVersion: 1, postVersion: 2,
      reversibleFields: { projectId: { before: PROJECT, after: destination }, position: { before: 0, after: 1 } },
      outcome: { targetId: TASK, targetVersion: 2, sourceOrderVersion: 5, destinationOrderVersion: 8 }, undoStatus: 'available', undoOfActionId: null,
      undoActionId: null, createdAt: '2026-10-15T12:00:01.000Z'
    };
    const current = { ...row('todo', [], 2), project_id: destination, position: 1 };
    const query = jest.fn().mockImplementation(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('FROM "project_tasks" t')) return [current];
      if (sql.includes('FROM "projects"')) return [{ status: 'active' }];
      if (sql.includes('FROM "project_task_order_states"')) return [{ version: values[1] === PROJECT ? 5 : 8 }];
      if (sql.includes('count(*) AS "count"')) return [{ count: 2 }];
      if (sql.includes('max(t."position")')) return [{ max_position: 1 }];
      if (sql.startsWith('UPDATE "project_tasks" SET "project_id"')) return [{ version: 3 }];
      if (sql.startsWith('UPDATE "project_task_order_states"')) return [{ version: values[1] === PROJECT ? 6 : 9 }];
      return [];
    });
    const { repository } = fixture('todo', []);

    const result = await repository.undoTaskInTransaction({ query } as unknown as QueryRunner, { ownerId: OWNER, original });

    const restore = query.mock.calls.find(([sql]: [string]) => sql.startsWith('UPDATE "project_tasks" SET "project_id"'));
    expect(restore?.[1]).toEqual([PROJECT, 0, OWNER, TASK, 2, destination]);
    expect(result).toMatchObject({ preVersion: 2, postVersion: 3, outcome: { targetId: TASK, targetVersion: 3, sourceOrderVersion: 9, destinationOrderVersion: 6 } });
  });

  it('restores an archived task status and archive timestamp at a new version', async () => {
    const original: ActionLedgerRecord = {
      id: '88888888-8888-4888-8888-888888888888', ownerId: OWNER, operationKey: 'task-archive', requestFingerprint: 'fp',
      actorKind: 'manual', turnId: null, targetKind: 'task', targetId: TASK, actionKind: 'task.archive', expectedVersion: 1,
      preVersion: 1, postVersion: 2,
      reversibleFields: {
        status: { before: 'todo', after: 'archived' },
        archivedAt: { before: null, after: '2026-10-15T12:00:00.123456Z' }
      },
      outcome: { targetId: TASK, targetVersion: 2, sourceOrderVersion: 8 }, undoStatus: 'available', undoOfActionId: null,
      undoActionId: null, createdAt: '2026-10-15T12:00:01.000Z'
    };
    const current = { ...row('archived', [], 2), archived_at: '2026-10-15T12:00:00.123Z', archived_at_exact: '2026-10-15T12:00:00.123456Z' };
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "project_tasks" t')) return [current];
      if (sql.includes('FROM "projects"')) return [{ status: 'active' }];
      if (sql.includes('FROM "project_task_order_states"')) return [{ version: 8 }];
      if (sql.includes('count(*) AS "count"')) return [{ count: 2 }];
      if (sql.includes('max(t."position")')) return [{ max_position: 1 }];
      if (sql.startsWith('UPDATE "project_tasks" SET "status" = $1')) return [{ version: 3 }];
      if (sql.startsWith('UPDATE "project_task_order_states"')) return [{ version: 9 }];
      return [];
    });
    const { repository } = fixture('todo', []);

    const result = await repository.undoTaskInTransaction({ query } as unknown as QueryRunner, { ownerId: OWNER, original });

    const restore = query.mock.calls.find(([sql]: [string]) => sql.startsWith('UPDATE "project_tasks" SET "status" = $1'));
    expect(restore?.[1]).toEqual(['todo', null, OWNER, TASK, 2]);
    expect(result).toMatchObject({ preVersion: 2, postVersion: 3, outcome: { targetId: TASK, targetVersion: 3, sourceOrderVersion: 9 } });
  });
});
