import type { QueryRunner } from 'typeorm';
import { lockProjectWriteState } from '@/infrastructure/database/project-removal-write-barrier';

function queryRunner(results: unknown[][]): QueryRunner {
  return { query: jest.fn().mockImplementation(async () => results.shift() ?? []) } as unknown as QueryRunner;
}

describe('lockProjectWriteState', () => {
  it('locks the owner project before checking the committed removal job', async () => {
    const transaction = queryRunner([[{ status: 'active', relative_root: 'projects/project-a' }], [{ project_id: 'project-a' }]]);

    await expect(lockProjectWriteState(transaction, 'owner-a', 'project-a')).resolves.toEqual({
      status: 'active',
      relativeRoot: 'projects/project-a',
      removalPending: true
    });

    expect(transaction.query).toHaveBeenNthCalledWith(1,
      'SELECT "status", "relative_root" FROM "projects" WHERE "owner_id" = $1 AND "id" = $2 LIMIT 1 FOR UPDATE',
      ['owner-a', 'project-a']
    );
    expect(transaction.query).toHaveBeenNthCalledWith(2,
      'SELECT "project_id" FROM "project_removal_jobs" WHERE "owner_id" = $1 AND "project_id" = $2 LIMIT 1',
      ['owner-a', 'project-a']
    );
  });

  it('does not query a removal job for a missing owner-scoped project', async () => {
    const transaction = queryRunner([[]]);

    await expect(lockProjectWriteState(transaction, 'owner-a', 'foreign-project')).resolves.toBeNull();
    expect(transaction.query).toHaveBeenCalledTimes(1);
  });
});
