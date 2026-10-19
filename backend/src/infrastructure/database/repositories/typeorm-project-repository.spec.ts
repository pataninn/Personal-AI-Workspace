import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmProjectRepository } from '@/infrastructure/database/repositories/typeorm-project-repository';
import type { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { ActionLedgerTargetStateConflictError } from '@/modules/action-ledger/domain/action-ledger-errors';
import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';
import type { ProjectStatus } from '@/modules/projects/domain/project-types';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-10-01T01:02:03.000Z';
const UPDATED_AT = '2026-10-02T01:02:03.000Z';

const passThroughStorageAccounting = {
  runMutation: async <T>(_transaction: unknown, _ownerId: string, mutation: () => Promise<T>): Promise<T> => mutation()
} as unknown as TypeOrmStorageContentAccounting;

function withProjectRemovalBarrier(query: jest.Mock, removalPending = false): jest.Mock {
  return jest.fn(async (sql: string, parameters?: unknown[]): Promise<unknown> => {
    if (sql.includes('SELECT "status", "relative_root" FROM "projects"')) return [{ status: 'active', relative_root: 'apps/website' }];
    if (sql.includes('FROM "project_removal_jobs"')) return removalPending ? [{ project_id: PROJECT_ID }] : [];
    return query(sql, parameters);
  });
}

function projectRow(status: ProjectStatus): Record<string, unknown> {
  return {
    id: PROJECT_ID,
    owner_id: OWNER_ID,
    name: 'Website',
    slug: 'website',
    relative_root: 'apps/website',
    relative_root_key: 'apps/website',
    storage_kind: 'legacy',
    objective: null,
    status,
    version: 2,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT
  };
}

function fixture(query: jest.Mock): {
  readonly repository: TypeOrmProjectRepository;
  readonly commitTransaction: jest.Mock;
  readonly rollbackTransaction: jest.Mock;
  readonly release: jest.Mock;
} {
  const queryRunner = {
    query: withProjectRemovalBarrier(query),
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined)
  };
  // Only the QueryRunner operations used by this repository are needed in the fixture.
  const dataSource = { createQueryRunner: () => queryRunner } as unknown as DataSource;
  return { repository: new TypeOrmProjectRepository(dataSource, passThroughStorageAccounting), ...queryRunner };
}

describe('TypeOrmProjectRepository', () => {
  it('maps a rootless planning row with its objective without inventing a file root', async () => {
    const row = { ...projectRow('active'), relative_root: null, relative_root_key: null, storage_kind: null, objective: 'Plan the launch' };
    const dataSource = { query: jest.fn().mockResolvedValue([row]) } as unknown as DataSource;
    const project = (await new TypeOrmProjectRepository(dataSource).listByOwner(OWNER_ID, false))[0];

    expect(project).toMatchObject({ relativeRoot: null, objective: 'Plan the launch' });
  });

  it('creates a rootless project without overlap lookup and persists null root columns', async () => {
    const row = { ...projectRow('active'), relative_root: null, relative_root_key: null, storage_kind: null, objective: 'Plan the launch' };
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    const { repository, commitTransaction, rollbackTransaction } = fixture(query);

    const project = await repository.create({ id: PROJECT_ID, ownerId: OWNER_ID, name: 'Planning', slug: 'planning', relativeRoot: null, storageKind: null, relativeRootKey: null, objective: 'Plan the launch' });

    expect(project).toMatchObject({ relativeRoot: null, objective: 'Plan the launch' });
    expect(query.mock.calls[1]?.[0]).toContain('FROM "storage_root_mappings"');
    expect(query.mock.calls[2]?.[0]).toContain('"relative_root_key", "storage_kind", "objective"');
    expect(query.mock.calls[2]?.[1]).toEqual([PROJECT_ID, OWNER_ID, 'Planning', 'planning', null, null, null, 'Plan the launch']);
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(rollbackTransaction).not.toHaveBeenCalled();
  });

  it.each<ProjectStatus>(['archived', 'active'])('returns a serializable project after changing status to %s', async (status) => {
    const query = jest.fn().mockResolvedValueOnce([]);
    if (status === 'active') {
      query.mockResolvedValueOnce([{ relative_root: 'apps/website', storage_kind: 'legacy' }]).mockResolvedValueOnce([]);
    }
    query.mockResolvedValueOnce([[projectRow(status)], 1]);
    const { repository, commitTransaction, rollbackTransaction, release } = fixture(query);

    const project = await repository.updateStatus({ ownerId: OWNER_ID, projectId: PROJECT_ID, status, expectedVersion: 1 });

    expect(project).toMatchObject({ id: PROJECT_ID, ownerId: OWNER_ID, status, version: 2, relativeRoot: 'apps/website' });
    expect(project?.createdAt.toISOString()).toBe(CREATED_AT);
    expect(project?.updatedAt.toISOString()).toBe(UPDATED_AT);
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(rollbackTransaction).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    if (status === 'active') {
      const rootsQuery = query.mock.calls.find(([sql]: [string]) => sql.includes('"storage_kind" IS NOT DISTINCT FROM $3'));
      expect(rootsQuery?.[1]).toEqual([OWNER_ID, PROJECT_ID, 'legacy']);
    }
  });

  it('checks overlap only within the project storage mount when reactivating', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ relative_root: 'projects/22222222-2222-4222-8222-222222222222', storage_kind: 'managed' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([[{ ...projectRow('active'), relative_root: 'projects/22222222-2222-4222-8222-222222222222', relative_root_key: 'projects/22222222-2222-4222-8222-222222222222', storage_kind: 'managed' }], 1]);
    const { repository } = fixture(query);

    await expect(repository.updateStatus({ ownerId: OWNER_ID, projectId: PROJECT_ID, status: 'active', expectedVersion: 1 }))
      .resolves.toMatchObject({ status: 'active', storageKind: 'managed' });
    const rootsQuery = query.mock.calls.find(([sql]: [string]) => sql.includes('"storage_kind" IS NOT DISTINCT FROM $3'));
    expect(rootsQuery?.[1]).toEqual([OWNER_ID, PROJECT_ID, 'managed']);
  });

  it('returns null when the versioned UPDATE affects no rows', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([[], 0]);
    const { repository, commitTransaction, rollbackTransaction, release } = fixture(query);

    await expect(repository.updateStatus({ ownerId: OWNER_ID, projectId: PROJECT_ID, status: 'archived', expectedVersion: 1 }))
      .resolves.toBeNull();

    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(rollbackTransaction).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases the transaction when the UPDATE fails', async () => {
    const failure = new Error('Database update failed');
    const query = jest.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(failure);
    const { repository, commitTransaction, rollbackTransaction, release } = fixture(query);

    await expect(repository.updateStatus({ ownerId: OWNER_ID, projectId: PROJECT_ID, status: 'archived', expectedVersion: 1 }))
      .rejects.toBe(failure);

    expect(commitTransaction).not.toHaveBeenCalled();
    expect(rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('searches only owner-owned active metadata and reads one extra row for bounded pagination', async () => {
    const rows = [
      { ...projectRow('active'), id: PROJECT_ID },
      { ...projectRow('active'), id: '33333333-3333-4333-8333-333333333333', name: 'Launch planning' },
      { ...projectRow('active'), id: '44444444-4444-4444-8444-444444444444', name: 'Another launch' }
    ];
    const query = jest.fn().mockResolvedValue(rows);
    const dataSource = { query } as unknown as DataSource;

    const result = await new TypeOrmProjectRepository(dataSource).searchForOwner(OWNER_ID, 'launch', 2);

    expect(result.projects).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(query.mock.calls[0]?.[0]).toContain('"owner_id" = $1 AND "status" = \'active\'');
    expect(query.mock.calls[0]?.[1]).toEqual([OWNER_ID, 'launch', 3]);
  });

  it('creates a planning workspace on the supplied ledger transaction without opening a nested transaction', async () => {
    const row = { ...projectRow('active'), id: '33333333-3333-4333-8333-333333333333', relative_root: null, relative_root_key: null, storage_kind: null, objective: 'Prepare the release' };
    const query = jest.fn().mockResolvedValue([row]);
    const runner = { query: withProjectRemovalBarrier(query) };
    const createQueryRunner = jest.fn();
    const repository = new TypeOrmProjectRepository({ createQueryRunner } as unknown as DataSource);

    const created = await repository.createPlanning(runner as never, {
      id: row.id,
      ownerId: OWNER_ID,
      name: 'Release plan',
      slug: 'release-plan',
      objective: 'Prepare the release'
    });

    expect(created).toMatchObject({ id: row.id, relativeRoot: null, objective: 'Prepare the release', version: 2 });
    expect(query.mock.calls[0]?.[0]).toContain('INSERT INTO "projects" ("id", "owner_id"');
    expect(query.mock.calls[0]?.[1]).toEqual([row.id, OWNER_ID, 'Release plan', 'release-plan', 'Prepare the release']);
    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it('uses owner and row locks plus the same QueryRunner for initial-root overlap checks and update', async () => {
    const rootless = { ...projectRow('active'), relative_root: null, relative_root_key: null, storage_kind: null, objective: 'Prepare the release' };
    const attached = { ...rootless, relative_root: '.', relative_root_key: '.', storage_kind: 'managed', version: 3 };
    const query = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rootless])
      .mockResolvedValueOnce([{ relative_root: 'apps/site' }])
      .mockResolvedValueOnce([[attached], 1]);
    const runner = { query: withProjectRemovalBarrier(query) };
    const createQueryRunner = jest.fn();
    const repository = new TypeOrmProjectRepository({ createQueryRunner } as unknown as DataSource);

    await repository.lockOwnerRoots(runner as never, OWNER_ID);
    const current = await repository.findByIdForOwnerForUpdate(runner as never, OWNER_ID, PROJECT_ID);
    const roots = await repository.listActiveRootKeys(runner as never, OWNER_ID, PROJECT_ID);
    const updated = await repository.attachInitialRoot(runner as never, {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      expectedVersion: 2,
      relativeRoot: '.',
      relativeRootKey: '.',
      storageKind: 'managed'
    });

    expect(current).toMatchObject({ id: PROJECT_ID, relativeRoot: null, version: 2 });
    expect(roots).toEqual(['apps/site']);
    expect(updated).toMatchObject({ relativeRoot: '.', version: 3 });
    expect(query.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[1]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls[1]?.[1]).toEqual([OWNER_ID, PROJECT_ID]);
    expect(query.mock.calls[3]?.[1]).toEqual(['.', '.', 'managed', OWNER_ID, PROJECT_ID, 2]);
    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it('updates objective through the supplied transaction with an expected-version predicate', async () => {
    const updatedRow = { ...projectRow('active'), objective: 'New objective', version: 3 };
    const query = jest.fn().mockResolvedValue([[updatedRow], 1]);
    const runner = { query: withProjectRemovalBarrier(query) };
    const createQueryRunner = jest.fn();
    const repository = new TypeOrmProjectRepository({ createQueryRunner } as unknown as DataSource);

    const updated = await repository.updateObjective(runner as never, {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      expectedVersion: 2,
      objective: 'New objective'
    });

    expect(updated).toMatchObject({ objective: 'New objective', version: 3 });
    expect(query.mock.calls[0]?.[0]).toContain('"version" = $4');
    expect(query.mock.calls[0]?.[1]).toEqual(['New objective', OWNER_ID, PROJECT_ID, 2]);
    expect(createQueryRunner).not.toHaveBeenCalled();
  });
});

describe('TypeOrmProjectRepository workspace undo participant', () => {
  const TASK_A = '33333333-3333-4333-8333-333333333333';
  const TASK_B = '44444444-4444-4444-8444-444444444444';
  const CREATE_A = '55555555-5555-4555-8555-555555555555';
  const CREATE_B = '66666666-6666-4666-8666-666666666666';
  const UNDO_A = '77777777-7777-4777-8777-777777777777';
  const UNDO_B = '88888888-8888-4888-8888-888888888888';
  const original: ActionLedgerRecord = {
    id: '99999999-9999-4999-8999-999999999999', ownerId: OWNER_ID, operationKey: 'workspace-create', requestFingerprint: 'fp',
    actorKind: 'manual', turnId: null, targetKind: 'workspace', targetId: PROJECT_ID, actionKind: 'workspace.create', expectedVersion: null,
    preVersion: null, postVersion: 2, reversibleFields: {}, outcome: { targetId: PROJECT_ID, targetVersion: 2 },
    undoStatus: 'available', undoOfActionId: null, undoActionId: null, createdAt: CREATED_AT
  };
  const rowForChild = (input: {
    readonly id: string;
    readonly taskId: string;
    readonly compensationId: string;
    readonly creationOrderVersion: number;
    readonly position: number;
  }) => ({
    id: input.id, action_kind: 'task.create', target_kind: 'task', target_id: input.taskId,
    undo_status: 'undone', undo_action_id: input.compensationId, creation_order_version: input.creationOrderVersion,
    compensation_id: input.compensationId, compensation_kind: 'undo', compensation_undo_status: 'not_reversible',
    compensation_undo_of: input.id, compensation_target_kind: 'task', compensation_target_id: input.taskId,
    compensation_target_version: 2, compensation_post_version: 2,
    task_owner_id: OWNER_ID, task_project_id: PROJECT_ID, task_status: 'archived', task_version: 2, task_position: input.position,
    created_event_count: 1, created_position: String(input.position), archive_event_count: 1, other_event_count: 0
  });

  it('archives an unchanged empty workspace after two child creates were compensated newest-first', async () => {
    const archived = { ...projectRow('archived'), relative_root: null, relative_root_key: null, version: 3 };
    const children = [
      rowForChild({ id: CREATE_B, taskId: TASK_B, compensationId: UNDO_B, creationOrderVersion: 3, position: 1 }),
      rowForChild({ id: CREATE_A, taskId: TASK_A, compensationId: UNDO_A, creationOrderVersion: 2, position: 0 })
    ];
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "projects"') && sql.includes('FOR UPDATE')) return [{ ...projectRow('active'), relative_root: null, relative_root_key: null, version: 2 }];
      if (sql.includes('FROM unnest($2::uuid[])')) return children;
      if (sql.includes('AS "has_content"')) return [{ has_content: false }];
      if (sql.startsWith('UPDATE "projects"')) return [archived];
      return [];
    });
    const { repository } = fixture(query);

    const result = await repository.undoWorkspaceInTransaction({ query } as unknown as QueryRunner, {
      ownerId: OWNER_ID, original, completedTaskCreateActionIds: [CREATE_B, CREATE_A]
    });

    expect(result).toMatchObject({ preVersion: 2, postVersion: 3, outcome: { targetId: PROJECT_ID, targetVersion: 3 } });
    expect(query.mock.calls.find(([sql]: [string]) => sql.includes('FROM unnest($2::uuid[])'))?.[1]).toEqual([OWNER_ID, [CREATE_B, CREATE_A], PROJECT_ID]);
    expect(query.mock.calls.some(([sql]: [string]) => sql.startsWith('UPDATE "projects"'))).toBe(true);
  });

  it('blocks a workspace edit after create before reading child receipts', async () => {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "projects"') && sql.includes('FOR UPDATE')) return [{ ...projectRow('active'), relative_root: null, relative_root_key: null, version: 3, name: 'Edited after create' }];
      return [];
    });
    const { repository } = fixture(query);

    await expect(repository.undoWorkspaceInTransaction({ query } as unknown as QueryRunner, {
      ownerId: OWNER_ID, original, completedTaskCreateActionIds: [CREATE_B, CREATE_A]
    })).rejects.toMatchObject({ reason: 'changed' });
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('FROM unnest($2::uuid[])'))).toBe(false);
    expect(query.mock.calls.some(([sql]: [string]) => sql.startsWith('UPDATE "projects"'))).toBe(false);
  });

  it('refuses to treat an unrelated or edited child receipt as workspace creation history', async () => {
    const child = { ...rowForChild({ id: CREATE_A, taskId: TASK_A, compensationId: UNDO_A, creationOrderVersion: 2, position: 0 }),
      other_event_count: 1 };
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "projects"') && sql.includes('FOR UPDATE')) return [{ ...projectRow('active'), relative_root: null, relative_root_key: null, version: 2 }];
      if (sql.includes('FROM unnest($2::uuid[])')) return [child];
      return [];
    });
    const { repository } = fixture(query);

    await expect(repository.undoWorkspaceInTransaction({ query } as unknown as QueryRunner, {
      ownerId: OWNER_ID, original, completedTaskCreateActionIds: [CREATE_A]
    })).rejects.toMatchObject({ reason: 'workspace_not_empty' });
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('AS "has_content"'))).toBe(false);
    expect(query.mock.calls.some(([sql]: [string]) => sql.startsWith('UPDATE "projects"'))).toBe(false);
  });

  it('restores workspace name and objective from the recorded before-image at a new version', async () => {
    const original: ActionLedgerRecord = {
      id: '99999999-9999-4999-8999-999999999999', ownerId: OWNER_ID, operationKey: 'workspace-update', requestFingerprint: 'fp',
      actorKind: 'manual', turnId: null, targetKind: 'workspace', targetId: PROJECT_ID, actionKind: 'workspace.update', expectedVersion: 1,
      preVersion: 1, postVersion: 2,
      reversibleFields: {
        name: { before: 'Website', after: 'Launch plan' },
        objective: { before: null, after: 'Prepare the release' }
      },
      outcome: { targetId: PROJECT_ID, targetVersion: 2 }, undoStatus: 'available', undoOfActionId: null,
      undoActionId: null, createdAt: CREATED_AT
    };
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "projects"') && sql.includes('FOR UPDATE')) {
        return [{ ...projectRow('active'), name: 'Launch plan', objective: 'Prepare the release', version: 2 }];
      }
      if (sql.startsWith('UPDATE "projects"')) {
        return [{ ...projectRow('active'), name: 'Website', objective: null, version: 3 }];
      }
      return [];
    });
    const { repository } = fixture(query);

    const result = await repository.undoWorkspaceInTransaction({ query } as unknown as QueryRunner, {
      ownerId: OWNER_ID, original, completedTaskCreateActionIds: []
    });

    const restore = query.mock.calls.find(([sql]: [string]) => sql.startsWith('UPDATE "projects"'));
    expect(restore?.[0]).toContain('"name" = $1, "objective" = $2');
    expect(restore?.[1]).toEqual(['Website', null, OWNER_ID, PROJECT_ID, 2]);
    expect(result).toMatchObject({ preVersion: 2, postVersion: 3, outcome: { targetId: PROJECT_ID, targetVersion: 3 } });
  });
});
