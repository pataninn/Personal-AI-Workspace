import type { DataSource } from 'typeorm';

import { TypeOrmProjectFactRepository } from '@/infrastructure/database/repositories/typeorm-project-fact-repository';
import type { ProjectFactVersionRecord, UpdateProjectFactRecord } from '@/modules/memory/repositories/project-fact-repository';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const FACT_ID = '33333333-3333-4333-8333-333333333333';
const CREATED_AT = new Date('2026-09-25T01:02:03.000Z');
const REVIEWED_AT = new Date('2026-09-26T01:02:03.000Z');

function row(overrides: Partial<{
  readonly version: number;
  readonly content: string;
  readonly verified_at: Date | string | null;
  readonly updated_at: Date | string;
}> = {}): Record<string, unknown> {
  return {
    id: FACT_ID,
    owner_id: OWNER_ID,
    project_id: PROJECT_ID,
    fact_key: 'test command',
    title: 'Test command',
    content: 'Run pnpm test.',
    version: 2,
    verified_at: REVIEWED_AT,
    created_at: CREATED_AT,
    updated_at: REVIEWED_AT,
    ...overrides
  };
}

function projectFactDataSource(query: jest.Mock): DataSource {
  return { query } as unknown as DataSource;
}

describe('TypeOrmProjectFactRepository', () => {
  it('unwraps TypeORM UPDATE results for review and maps a subsequent SELECT reread', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([[row()], 1])
      .mockResolvedValueOnce([row()]);
    const repository = new TypeOrmProjectFactRepository(projectFactDataSource(query));
    const input: ProjectFactVersionRecord = { ownerId: OWNER_ID, projectId: PROJECT_ID, factId: FACT_ID, expectedVersion: 1 };

    const reviewed = await repository.verify(input);
    const reread = await repository.listActiveByProject(OWNER_ID, PROJECT_ID);

    expect(reviewed).toMatchObject({
      id: FACT_ID,
      version: 2,
      verificationStatus: 'verified',
      verifiedAt: REVIEWED_AT,
      updatedAt: REVIEWED_AT
    });
    expect(reread[0]?.verifiedAt?.toISOString()).toBe(REVIEWED_AT.toISOString());
    expect(reread[0]?.verificationStatus).toBe('verified');
    const verificationSql = query.mock.calls[0]?.[0] as string;
    expect(verificationSql).toContain('"verified_at" = now()');
    expect(verificationSql).toContain('"updated_at" = now()');
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('"verified_at" = now()'), [OWNER_ID, PROJECT_ID, FACT_ID, 1]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('"deleted_at" IS NULL'), [OWNER_ID, PROJECT_ID]);
  });

  it('returns null when a versioned review UPDATE affects no rows', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const repository = new TypeOrmProjectFactRepository(projectFactDataSource(query));

    await expect(repository.verify({ ownerId: OWNER_ID, projectId: PROJECT_ID, factId: FACT_ID, expectedVersion: 8 }))
      .resolves.toBeNull();
  });

  it('unwraps UPDATE rows and distinguishes a stale optimistic edit from a returned fact', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([[row({ version: 3, verified_at: null, content: 'Run pnpm test --run.' })], 1])
      .mockResolvedValueOnce([[], 0]);
    const repository = new TypeOrmProjectFactRepository(projectFactDataSource(query));
    const update: UpdateProjectFactRecord = {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      factId: FACT_ID,
      key: 'test command',
      title: 'Test command',
      content: 'Run pnpm test --run.',
      expectedVersion: 2
    };

    const updated = await repository.update(update);
    const stale = await repository.update({ ...update, expectedVersion: 1 });

    expect(updated).toMatchObject({ version: 3, content: 'Run pnpm test --run.', verificationStatus: 'needs_review', verifiedAt: null });
    expect(stale).toBeNull();
  });

  it('uses the DELETE result row count instead of the outer TypeORM tuple truthiness', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([[], 0])
      .mockResolvedValueOnce([[{ id: FACT_ID }], 1]);
    const repository = new TypeOrmProjectFactRepository(projectFactDataSource(query));
    const input: ProjectFactVersionRecord = { ownerId: OWNER_ID, projectId: PROJECT_ID, factId: FACT_ID, expectedVersion: 1 };

    await expect(repository.softDelete(input)).resolves.toBe(false);
    await expect(repository.softDelete(input)).resolves.toBe(true);
  });
});
