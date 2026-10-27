import type { DataSource, EntityManager } from 'typeorm';

import { TypeOrmWorkspaceExportRepository } from '@/infrastructure/database/repositories/typeorm-workspace-export-repository';

const OWNER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const EXPORT = '33333333-3333-4333-8333-333333333333';

describe('TypeOrmWorkspaceExportRepository expiry clock', () => {
  it('expires a key using the database clock even when the API host clock would still see it as ready', async () => {
    const existing = {
      id: EXPORT, owner_id: OWNER, workspace_id: WORKSPACE, state: 'ready', request_fingerprint: 'b'.repeat(64),
      demo_cleanup_generation: null, builder_process_id: null, builder_start_ticks: null,
      created_at: '2098-12-31T23:45:00.000Z', expires_at: '2099-01-01T00:00:00.000Z', byte_count: 512,
      database_now: '2099-01-02T00:00:00.000Z'
    };
    const results: unknown[] = [
      [{ id: WORKSPACE, name: 'Research', objective: null, file_backed: false }],
      [{ id: OWNER }],
      [],
      [],
      [existing]
    ];
    const query = jest.fn(async (_sql: string, _parameters?: readonly unknown[]) => results.shift());
    const manager = { query } as unknown as EntityManager;
    const source = { transaction: async <T>(work: (entityManager: EntityManager) => Promise<T>) => work(manager) } as unknown as DataSource;
    const repository = new TypeOrmWorkspaceExportRepository(source);

    const result = await repository.begin({
      ownerId: OWNER, workspaceId: WORKSPACE, keyDigest: 'a'.repeat(64), requestFingerprint: 'b'.repeat(64),
      builder: { processId: 91, startTicks: '987654321' }
    });

    expect(result).toEqual({ kind: 'expired_key' });
    expect(query.mock.calls[4]?.[0]).toContain('clock_timestamp() AS "database_now"');
    expect(query).toHaveBeenCalledTimes(5);
  });

  it('uses the database clock for artifact and account expiry before download', async () => {
    const query = jest.fn(async (_sql: string, _parameters?: readonly unknown[]) => []);
    const source = { query } as unknown as DataSource;
    const repository = new TypeOrmWorkspaceExportRepository(source);

    await expect(repository.getDownload(OWNER, EXPORT)).resolves.toBeNull();

    const sql = query.mock.calls[0]?.[0] ?? '';
    expect(sql).toContain('e."expires_at">clock_timestamp()');
    expect(sql).toContain('u."expires_at">clock_timestamp()');
    expect(query.mock.calls[0]?.[1]).toEqual([EXPORT, OWNER]);
  });

  it('reports expiry only when PostgreSQL transitions a ready row using its clock', async () => {
    const query = jest.fn(async (_sql: string, _parameters?: readonly unknown[]) => [{ id: EXPORT }]);
    const source = { query } as unknown as DataSource;
    const repository = new TypeOrmWorkspaceExportRepository(source);

    await expect(repository.markExpired(EXPORT)).resolves.toBe(true);

    expect(query.mock.calls[0]?.[0]).toContain('"expires_at"<=clock_timestamp() RETURNING "id"');
    expect(query.mock.calls[0]?.[1]).toEqual([EXPORT]);
  });
});
