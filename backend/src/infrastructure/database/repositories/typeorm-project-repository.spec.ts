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
});
