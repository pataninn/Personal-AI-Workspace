import type { DataSource } from 'typeorm';

import { TypeOrmProjectTaskRepository } from '@/infrastructure/database/repositories/typeorm-project-task-repository';
import type { GlobalTaskQueryFilters } from '@/modules/tasks/domain/global-task-query';

const OWNER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const INBOX_TASK = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_TASK = '44444444-4444-4444-8444-444444444444';
const CREATED_AT = '2026-10-16T08:09:10.123456Z';

function taskRow(id: string, projectId: string | null, cursorCreatedAt = CREATED_AT) {
  return {
    id,
    owner_id: OWNER,
    project_id: projectId,
    title: `Task ${id}`,
    details: null,
    importance: 'high',
    deadline: '2026-10-30',
    subtasks: [],
    status: 'todo',
    position: 0,
    version: 1,
    source_kind: 'user',
    source_suggestion_id: null,
    source_run_id: null,
    source_conversation_id: null,
    source_accepted_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    completed_at: null,
    workspace_id: projectId,
    workspace_name: projectId ? 'Workspace' : null,
    workspace_status: projectId ? 'active' : null,
    cursor_created_at: cursorCreatedAt
  };
}

function createRepository(rows: readonly unknown[]) {
  const query = jest.fn().mockResolvedValue(rows);
  const dataSource = { query } as unknown as DataSource;
  return { repository: new TypeOrmProjectTaskRepository(dataSource), query };
}

describe('TypeOrmProjectTaskRepository global queries', () => {
  it('counts active owner Inbox tasks independently of filters or the current page', async () => {
    const { repository, query } = createRepository([{ count: '17' }]);

    await expect(repository.countInboxTasks({ ownerId: OWNER })).resolves.toBe(17);

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE "owner_id" = $1');
    expect(sql).toContain('"project_id" IS NULL');
    expect(sql).toContain('"status" <> \'archived\'');
    expect(values).toEqual([OWNER]);
  });

  it('owner-scopes joined workspaces, maps Inbox, and emits the exact keyset position', async () => {
    const { repository, query } = createRepository([
      taskRow(INBOX_TASK, null),
      taskRow(WORKSPACE_TASK, WORKSPACE, '2026-10-16T08:09:09.000001Z')
    ]);
    const filters: GlobalTaskQueryFilters = {
      inboxOnly: false,
      status: 'todo',
      importance: 'high',
      deadlineFrom: '2026-10-01',
      deadlineTo: '2026-10-31',
      q: '50% off',
      includeArchived: false,
      limit: 1
    };

    const page = await repository.listGlobalTasks({ ownerId: OWNER, filters, after: null });

    expect(page).toMatchObject({ hasMore: true, lastPosition: { createdAt: CREATED_AT, taskId: INBOX_TASK } });
    expect(page.items[0]).toMatchObject({ task: { id: INBOX_TASK, projectId: null }, collection: 'inbox', workspace: null });
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE t."owner_id" = $1');
    expect(sql).toContain('p."owner_id" = t."owner_id"');
    expect(sql).toContain('t."created_at", t."id"');
    expect(sql).toContain('ORDER BY t."created_at" DESC, t."id" DESC');
    expect(sql).toContain('t."status" <> \'archived\'');
    expect(values).toEqual([OWNER, null, false, 'todo', 'high', '2026-10-01', '2026-10-31', '%50\\% off%', false, null, null, 2]);
  });

  it('maps workspace identity and applies an owner-scoped cursor on the following page', async () => {
    const after = { createdAt: CREATED_AT, taskId: INBOX_TASK };
    const { repository, query } = createRepository([taskRow(WORKSPACE_TASK, WORKSPACE)]);

    const page = await repository.listGlobalTasks({
      ownerId: OWNER,
      filters: { inboxOnly: false, includeArchived: true, limit: 25 },
      after
    });

    expect(page.items[0]).toMatchObject({
      collection: 'workspace',
      task: { id: WORKSPACE_TASK, projectId: WORKSPACE },
      workspace: { id: WORKSPACE, name: 'Workspace', status: 'active' }
    });
    expect(page.hasMore).toBe(false);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('($10::timestamptz IS NULL OR (t."created_at", t."id") < ($10::timestamptz, $11::uuid))');
    expect(values.slice(8)).toEqual([true, CREATED_AT, INBOX_TASK, 26]);
  });

  it('does not return foreign or archived detail rows unless history is requested', async () => {
    const { repository, query } = createRepository([]);

    await expect(repository.getGlobalTask({ ownerId: OWNER, taskId: WORKSPACE_TASK, includeArchived: false })).resolves.toBeNull();

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE t."owner_id" = $1 AND t."id" = $2');
    expect(sql).toContain('t."status" <> \'archived\'');
    expect(sql).toContain('p."owner_id" = t."owner_id"');
    expect(values).toEqual([OWNER, WORKSPACE_TASK, false]);
  });

  it('returns active task history in an archived workspace only for an explicit owner-scoped read', async () => {
    const archivedRow = {
      ...taskRow(WORKSPACE_TASK, WORKSPACE),
      workspace_status: 'archived' as const
    };
    const { repository, query } = createRepository([archivedRow]);

    const item = await repository.getGlobalTask({ ownerId: OWNER, taskId: WORKSPACE_TASK, includeArchived: true });

    expect(item).toMatchObject({
      task: { id: WORKSPACE_TASK, status: 'todo' },
      workspace: { id: WORKSPACE, status: 'archived' }
    });
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE t."owner_id" = $1 AND t."id" = $2');
    expect(values).toEqual([OWNER, WORKSPACE_TASK, true]);
  });
});
