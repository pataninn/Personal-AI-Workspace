import { Buffer } from 'node:buffer';
import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmProjectTaskRepository } from '@/infrastructure/database/repositories/typeorm-project-task-repository';
import { normalizeTaskDetails, normalizeTaskTitle } from '@/modules/tasks/domain/project-task-validation';
import { normalizeTaskSubtasks } from '@/modules/tasks/domain/task-planning-validation';
import {
  ProjectTaskArchivedProjectError,
  ProjectTaskNotFoundError,
  ProjectTaskVersionConflictError
} from '@/modules/tasks/domain/project-task-errors';
import type { ProjectTaskStatus } from '@/modules/tasks/domain/project-task';
import type { CreateTaskMutationInput, MoveTaskMutationInput, UpdateTaskMutationInput } from '@/modules/tasks/repositories/task-mutation-participant';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK = '22222222-2222-4222-8222-222222222222';
const SOURCE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const DESTINATION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SUGGESTION = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const CONVERSATION = '55555555-5555-4555-8555-555555555555';

interface ParticipantFixtureOptions {
  readonly taskOwner?: string;
  readonly projectStatuses?: Readonly<Record<string, 'active' | 'archived'>>;
  readonly versionOnLockedTaskRead?: number;
  readonly taskStatus?: ProjectTaskStatus;
  readonly initialTask?: Partial<FakeTaskRow>;
  readonly updateResultTask?: Partial<FakeTaskRow>;
}

interface FakeTaskRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  details: string | null;
  importance: 'low' | 'medium' | 'high' | 'urgent';
  deadline: string | null;
  subtasks: Array<{ id: string; title: string; completed: boolean }>;
  status: ProjectTaskStatus;
  position: number;
  version: number;
  source_kind: 'user' | 'assistant_suggestion';
  source_suggestion_id: string | null;
  source_run_id: string | null;
  source_conversation_id: string | null;
  source_accepted_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
}

function createFixture(options: ParticipantFixtureOptions = {}) {
  let taskReadCount = 0;
  let currentTask: FakeTaskRow = {
    id: TASK,
    owner_id: options.taskOwner ?? OWNER,
    project_id: SOURCE as string | null,
    title: 'Keep provenance',
    details: 'Created from a suggestion',
    importance: 'high',
    deadline: '2026-11-02',
    subtasks: [{ id: '66666666-6666-4666-8666-666666666666', title: 'Preserve checklist', completed: false }],
    status: options.taskStatus ?? 'todo' as ProjectTaskStatus,
    position: 0,
    version: 1,
    source_kind: 'assistant_suggestion' as const,
    source_suggestion_id: SUGGESTION,
    source_run_id: RUN,
    source_conversation_id: CONVERSATION,
    source_accepted_at: '2026-10-15T10:00:00.000Z',
    created_at: '2026-10-15T09:00:00.000Z',
    updated_at: '2026-10-15T09:00:00.000Z',
    completed_at: null as string | null,
    archived_at: null as string | null
  };
  currentTask = { ...currentTask, ...options.initialTask };
  const projectLocks: string[] = [];
  const collectionLocks: string[] = [];
  const writes: Array<{ readonly sql: string; readonly parameters: readonly unknown[] }> = [];
  const orderVersions = new Map<string, number>([[SOURCE, 4], [DESTINATION, 8], ['inbox', 3]]);
  const query = jest.fn().mockImplementation(async (sql: string, parameters: readonly unknown[] = []) => {
    if (sql.includes('FROM "projects"') && sql.includes('FOR UPDATE')) {
      const projectId = String(parameters[1]);
      projectLocks.push(projectId);
      const status = options.projectStatuses?.[projectId] ?? 'active';
      return options.projectStatuses && !(projectId in options.projectStatuses)
        ? []
        : [{ status, relative_root: `projects/${projectId}` }];
    }
    if (sql.includes('FROM "project_removal_jobs"')) return [];
    if (sql.includes('FROM "project_task_order_states"') && sql.includes('FOR UPDATE')) {
      const key = sql.includes('"project_id" IS NULL') ? 'inbox' : String(parameters[1]);
      collectionLocks.push(key);
      const version = orderVersions.get(key);
      return version === undefined ? [] : [{ version }];
    }
    if (sql.includes('FROM "project_task_order_states"')) {
      const key = sql.includes('"project_id" IS NULL') ? 'inbox' : String(parameters[1]);
      const version = orderVersions.get(key);
      return version === undefined ? [] : [{ version }];
    }
    if (sql.includes('FROM "project_tasks" t') && sql.includes('count(*)')) {
      return [{ count: 2 }];
    }
    if (sql.includes('FROM "project_tasks" t') && sql.includes('max(t."position")')) {
      return [{ max_position: 1 }];
    }
    if (sql.includes('FROM "project_tasks" t') && sql.includes('AND t."id" = $2')) {
      if (String(parameters[0]) !== OWNER || currentTask.owner_id !== OWNER) return [];
      taskReadCount += 1;
      const version = taskReadCount === 2 && options.versionOnLockedTaskRead !== undefined
        ? options.versionOnLockedTaskRead
        : currentTask.version;
      return [{ ...currentTask, version }];
    }
    if (sql.startsWith('INSERT INTO "project_task_order_states"')) return [];
    if (sql.startsWith('INSERT INTO "project_tasks"')) {
      writes.push({ sql, parameters });
      currentTask = {
        id: String(parameters[0]),
        owner_id: String(parameters[1]),
        project_id: parameters[2] as string | null,
        title: String(parameters[3]),
        details: parameters[4] as string | null,
        importance: parameters[6] as 'low' | 'medium' | 'high' | 'urgent',
        deadline: parameters[7] as string | null,
        subtasks: JSON.parse(String(parameters[8])) as typeof currentTask.subtasks,
        status: parameters[9] as ProjectTaskStatus,
        position: Number(parameters[5]),
        version: 1,
        source_kind: 'user',
        source_suggestion_id: null,
        source_run_id: null,
        source_conversation_id: null,
        source_accepted_at: null,
        created_at: '2026-10-16T09:00:00.000Z',
        updated_at: '2026-10-16T09:00:00.000Z',
        completed_at: null,
        archived_at: null
      };
      return [{ id: currentTask.id }];
    }
    if (sql.startsWith('SELECT count(*)')) return [{ count: 2 }];
    if (sql.startsWith('SELECT max(')) return [{ max_position: 1 }];
    if (sql.startsWith('UPDATE "project_tasks" SET "project_id"')) {
      writes.push({ sql, parameters });
      currentTask = { ...currentTask, project_id: parameters[0] as string | null, position: Number(parameters[1]), version: currentTask.version + 1 };
      return [{ id: TASK }];
    }
    if (sql.startsWith('UPDATE "project_tasks" SET "status"')) {
      writes.push({ sql, parameters });
      currentTask = { ...currentTask, status: 'archived', archived_at: '2026-10-16T10:00:00.000Z', version: currentTask.version + 1 };
      return [{ id: TASK }];
    }
    if (sql.startsWith('UPDATE "project_tasks" SET "version" = "version" + 1')) {
      writes.push({ sql, parameters });
      currentTask = { ...currentTask, ...options.updateResultTask, version: currentTask.version + 1 };
      return [{ id: TASK }];
    }
    if (sql.startsWith('UPDATE "project_tasks"')) {
      writes.push({ sql, parameters });
      return [];
    }
    if (sql.startsWith('UPDATE "project_task_order_states"')) {
      writes.push({ sql, parameters });
      const key = sql.includes('"project_id" IS NULL') ? 'inbox' : String(parameters[1]);
      const next = (orderVersions.get(key) ?? 0) + 1;
      orderVersions.set(key, next);
      return [{ version: next }];
    }
    if (sql.startsWith('INSERT INTO "project_task_events"')) {
      writes.push({ sql, parameters });
      return [];
    }
    throw new Error(`Unexpected task mutation query: ${sql}`);
  });
  const runner = { query } as unknown as QueryRunner;
  const dataSource = {
    createQueryRunner: jest.fn(() => { throw new Error('A ledger transaction must supply the query runner.'); })
  } as unknown as DataSource;
  return {
    repository: new TypeOrmProjectTaskRepository(dataSource),
    query,
    runner,
    projectLocks,
    collectionLocks,
    writes,
    get task() { return currentTask; }
  };
}

function moveInput(destinationProjectId: string | null, overrides: Partial<MoveTaskMutationInput> = {}): MoveTaskMutationInput {
  return {
    ownerId: OWNER,
    taskId: TASK,
    expectedVersion: 1,
    destinationProjectId,
    actorKind: 'manual',
    ...overrides
  };
}

describe('task action-ledger transaction participant', () => {
  it('creates directly into Inbox using the ledger-supplied runner and advances Inbox order once', async () => {
    const fixture = createFixture();
    const input: CreateTaskMutationInput = {
      ownerId: OWNER,
      taskId: TASK,
      projectId: null,
      title: 'A planning task',
      details: null,
      importance: 'medium',
      deadline: null,
      subtasks: [],
      actorKind: 'manual',
      expectedOrderVersion: 3
    };

    const applied = await fixture.repository.createInTransaction(fixture.runner, input);

    expect(applied.task).toMatchObject({ id: TASK, projectId: null, title: 'A planning task', position: 2, version: 1, source: { kind: 'user' } });
    expect(applied).toMatchObject({ preVersion: null, postVersion: 1, outcome: { targetId: TASK, targetVersion: 1, destinationOrderVersion: 4 }, undoStatus: 'available' });
    expect(fixture.projectLocks).toEqual([]);
    expect(fixture.collectionLocks).toEqual(['inbox']);
    expect(fixture.writes.some(({ sql }) => sql.startsWith('INSERT INTO "project_task_events"'))).toBe(true);
  });

  it('moves a suggested task into Inbox while preserving identity, checklist, deadline, and provenance', async () => {
    const fixture = createFixture();

    const applied = await fixture.repository.moveInTransaction(fixture.runner, moveInput(null, {
      expectedSourceOrderVersion: 4,
      expectedDestinationOrderVersion: 3
    }));

    expect(applied.task).toMatchObject({
      id: TASK,
      projectId: null,
      position: 2,
      version: 2,
      importance: 'high',
      deadline: '2026-11-02',
      subtasks: [{ title: 'Preserve checklist', completed: false }],
      source: { kind: 'assistant_suggestion', suggestionId: SUGGESTION, runId: RUN, conversationId: CONVERSATION }
    });
    expect(applied.outcome).toMatchObject({ targetId: TASK, targetVersion: 2, sourceOrderVersion: 5, destinationOrderVersion: 4 });
    expect(fixture.projectLocks).toEqual([SOURCE]);
    expect(fixture.collectionLocks).toEqual(['inbox', SOURCE]);
    const sourceProjectLock = fixture.query.mock.calls.find(([sql, parameters]) =>
      String(sql).includes('SELECT "status", "relative_root" FROM "projects"')
      && (parameters as readonly unknown[])[1] === SOURCE);
    expect(sourceProjectLock?.[1]).toEqual([OWNER, SOURCE]);
    expect(fixture.writes.some(({ sql, parameters }) => sql.startsWith('UPDATE "project_tasks" SET "project_id"') && parameters[0] === null)).toBe(true);
    expect(fixture.writes.some(({ sql }) => sql.startsWith('INSERT INTO "project_task_events"'))).toBe(true);
  });

  it('locks workspace rows in stable ID order and rejects an archived target before task writes', async () => {
    const archivedTarget = createFixture({ projectStatuses: { [SOURCE]: 'active', [DESTINATION]: 'archived' } });

    await expect(archivedTarget.repository.moveInTransaction(archivedTarget.runner, moveInput(DESTINATION)))
      .rejects.toBeInstanceOf(ProjectTaskArchivedProjectError);
    expect(archivedTarget.projectLocks).toEqual([DESTINATION]);
    expect(archivedTarget.collectionLocks).toEqual([]);
    expect(archivedTarget.writes.some(({ sql }) => sql.startsWith('UPDATE "project_tasks"'))).toBe(false);

    const activeTarget = createFixture();
    await activeTarget.repository.moveInTransaction(activeTarget.runner, moveInput(DESTINATION));
    expect(activeTarget.projectLocks).toEqual([DESTINATION, SOURCE]);
    expect(activeTarget.collectionLocks).toEqual([DESTINATION, SOURCE]);
  });

  it('hides foreign task IDs and detects a stale locked task version before updating', async () => {
    const foreign = createFixture({ taskOwner: OTHER_OWNER });
    await expect(foreign.repository.moveInTransaction(foreign.runner, moveInput(DESTINATION)))
      .rejects.toBeInstanceOf(ProjectTaskNotFoundError);
    expect(foreign.projectLocks).toEqual([]);

    const stale = createFixture({ versionOnLockedTaskRead: 2 });
    await expect(stale.repository.moveInTransaction(stale.runner, moveInput(DESTINATION)))
      .rejects.toBeInstanceOf(ProjectTaskVersionConflictError);
    expect(stale.writes.some(({ sql }) => sql.startsWith('UPDATE "project_tasks" SET "project_id"'))).toBe(false);
  });

  it('archives without deleting the task row and advances the source order version', async () => {
    const fixture = createFixture();

    const applied = await fixture.repository.archiveInTransaction(fixture.runner, {
      ownerId: OWNER,
      taskId: TASK,
      expectedVersion: 1,
      expectedProjectId: SOURCE,
      expectedOrderVersion: 4,
      actorKind: 'manual'
    });

    expect(applied.task).toMatchObject({ id: TASK, status: 'archived', version: 2, archivedAt: expect.any(Date) });
    expect(applied.outcome).toMatchObject({ targetId: TASK, targetVersion: 2, sourceOrderVersion: 5 });
    expect(fixture.writes.some(({ sql }) => sql.startsWith('DELETE FROM "project_tasks"'))).toBe(false);
    expect(fixture.writes.some(({ sql }) => sql.startsWith('UPDATE "project_tasks" SET "status"'))).toBe(true);
    expect(fixture.task.source_suggestion_id).toBe(SUGGESTION);
    expect(fixture.task.subtasks).toHaveLength(1);
  });

  it('keeps undo available for a maximum-shape valid task edit above the old 8 KiB receipt limit', async () => {
    const beforeTitle = normalizeTaskTitle('🧊'.repeat(120));
    const afterTitle = normalizeTaskTitle('🌍'.repeat(120));
    const beforeDetails = normalizeTaskDetails('\\'.repeat(4096)) ?? '';
    const afterDetails = normalizeTaskDetails('"'.repeat(4096)) ?? '';
    const makeSubtasks = (title: string, completed: boolean) => [...normalizeTaskSubtasks(Array.from({ length: 50 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      title,
      completed
    })))];
    const beforeSubtasks = makeSubtasks(beforeTitle, false);
    const afterSubtasks = makeSubtasks(afterTitle, true);
    const fixture = createFixture({
      initialTask: {
        title: beforeTitle,
        details: beforeDetails,
        importance: 'low',
        deadline: null,
        subtasks: beforeSubtasks
      },
      updateResultTask: {
        title: afterTitle,
        details: afterDetails,
        importance: 'urgent',
        deadline: '2026-12-31',
        subtasks: afterSubtasks,
        status: 'done',
        completed_at: '2026-10-16T10:00:00.000Z'
      }
    });
    const update: UpdateTaskMutationInput = {
      ownerId: OWNER,
      taskId: TASK,
      expectedVersion: 1,
      expectedProjectId: SOURCE,
      title: afterTitle,
      details: afterDetails,
      importance: 'urgent',
      deadline: '2026-12-31',
      subtasks: afterSubtasks,
      actorKind: 'manual'
    };

    const applied = await fixture.repository.updateInTransaction(fixture.runner, update);
    const serializedBytes = Buffer.byteLength(JSON.stringify(applied.reversibleFields), 'utf8');

    expect(Buffer.byteLength(beforeDetails, 'utf8')).toBe(4096);
    expect(Buffer.byteLength(afterDetails, 'utf8')).toBe(4096);
    expect(serializedBytes).toBeGreaterThan(8192);
    expect(serializedBytes).toBeLessThanOrEqual(81920);
    expect(applied.undoStatus).toBe('available');
    expect(Object.keys(applied.reversibleFields)).toEqual(expect.arrayContaining(['title', 'details', 'status', 'importance', 'deadline', 'subtasks']));
    expect(applied.reversibleFields.details?.before).toBe(beforeDetails);
    expect(applied.reversibleFields.details?.after).toBe(afterDetails);
  });
});
