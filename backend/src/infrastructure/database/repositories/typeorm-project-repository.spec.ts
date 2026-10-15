import type { DataSource } from 'typeorm';

import { TypeOrmProjectRepository } from '@/infrastructure/database/repositories/typeorm-project-repository';
import type { ProjectStatus } from '@/modules/projects/domain/project-types';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-10-01T01:02:03.000Z';
const UPDATED_AT = '2026-10-02T01:02:03.000Z';

function projectRow(status: ProjectStatus): Record<string, unknown> {
  return {
    id: PROJECT_ID,
    owner_id: OWNER_ID,
    name: 'Website',
    slug: 'website',
    relative_root: 'apps/website',
    relative_root_key: 'apps/website',
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
    query,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined)
  };
  // Only the QueryRunner operations used by this repository are needed in the fixture.
  const dataSource = { createQueryRunner: () => queryRunner } as unknown as DataSource;
  return { repository: new TypeOrmProjectRepository(dataSource), ...queryRunner };
}

describe('TypeOrmProjectRepository', () => {
  it('maps a rootless planning row with its objective without inventing a file root', async () => {
    const row = { ...projectRow('active'), relative_root: null, relative_root_key: null, objective: 'Plan the launch' };
    const dataSource = { query: jest.fn().mockResolvedValue([row]) } as unknown as DataSource;
    const project = (await new TypeOrmProjectRepository(dataSource).listByOwner(OWNER_ID, false))[0];

    expect(project).toMatchObject({ relativeRoot: null, objective: 'Plan the launch' });
  });

  it('creates a rootless project without overlap lookup and persists null root columns', async () => {
    const row = { ...projectRow('active'), relative_root: null, relative_root_key: null, objective: 'Plan the launch' };
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    const { repository, commitTransaction, rollbackTransaction } = fixture(query);

    const project = await repository.create({ ownerId: OWNER_ID, name: 'Planning', slug: 'planning', relativeRoot: null, relativeRootKey: null, objective: 'Plan the launch' });

    expect(project).toMatchObject({ relativeRoot: null, objective: 'Plan the launch' });
    expect(query.mock.calls[1]?.[0]).toContain('"relative_root_key" IS NOT NULL');
    expect(query.mock.calls[2]?.[0]).toContain('"relative_root_key", "objective"');
    expect(query.mock.calls[2]?.[1]).toEqual([OWNER_ID, 'Planning', 'planning', null, null, 'Plan the launch']);
    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(rollbackTransaction).not.toHaveBeenCalled();
  });

  it.each<ProjectStatus>(['archived', 'active'])('returns a serializable project after changing status to %s', async (status) => {
    const query = jest.fn().mockResolvedValueOnce([]);
    if (status === 'active') {
      query.mockResolvedValueOnce([{ relative_root: 'apps/website' }]).mockResolvedValueOnce([]);
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
    const row = { ...projectRow('active'), id: '33333333-3333-4333-8333-333333333333', relative_root: null, relative_root_key: null, objective: 'Prepare the release' };
    const query = jest.fn().mockResolvedValue([row]);
    const runner = { query };
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
    const rootless = { ...projectRow('active'), relative_root: null, relative_root_key: null, objective: 'Prepare the release' };
    const attached = { ...rootless, relative_root: '.', relative_root_key: '.', version: 3 };
    const query = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rootless])
      .mockResolvedValueOnce([{ relative_root: 'apps/site' }])
      .mockResolvedValueOnce([[attached], 1]);
    const runner = { query };
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
      relativeRootKey: '.'
    });

    expect(current).toMatchObject({ id: PROJECT_ID, relativeRoot: null, version: 2 });
    expect(roots).toEqual(['apps/site']);
    expect(updated).toMatchObject({ relativeRoot: '.', version: 3 });
    expect(query.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[1]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls[1]?.[1]).toEqual([OWNER_ID, PROJECT_ID]);
    expect(query.mock.calls[3]?.[1]).toEqual(['.', '.', OWNER_ID, PROJECT_ID, 2]);
    expect(createQueryRunner).not.toHaveBeenCalled();
  });

  it('updates objective through the supplied transaction with an expected-version predicate', async () => {
    const updatedRow = { ...projectRow('active'), objective: 'New objective', version: 3 };
    const query = jest.fn().mockResolvedValue([[updatedRow], 1]);
    const runner = { query };
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
