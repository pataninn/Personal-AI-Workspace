import type { DataSource, QueryRunner } from 'typeorm';

import { storageFileOperationFingerprint } from '@/modules/storage-quotas/domain/storage-file-operation-fingerprint';
import type { StorageFileOperationCommand, StorageVerifiedFileChange } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { StorageQuotaTransaction } from '@/modules/storage-quotas/repositories/storage-quota-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';

const OWNER_ID = 'owner-1';

describe('TypeOrmStorageQuotaRepository', () => {
  it('reuses the caller transaction and locks account_limits before content writes', async () => {
    const order: string[] = [];
    const transaction = fakeQueryRunner(async (sql) => {
      order.push(sql);
      if (sql.includes('FROM "users"')) return [{ id: OWNER_ID }];
      if (sql.includes('SELECT "storage_limit_bytes"')) return [{ storage_limit_bytes: '100' }];
      if (sql.includes('SELECT "used_bytes"')) return [{ used_bytes: '20', reserved_bytes: '5', accounting_state: 'ready' }];
      if (sql.includes('SELECT "byte_count"')) return [{ byte_count: '10', sha256: null }];
      return [];
    });
    const repository = new TypeOrmStorageQuotaRepository({} as DataSource);
    const reference = databaseReference();

    const result = await repository.runDatabaseMutation(transaction, { ownerId: OWNER_ID, maximumGrowthBytes: 20n }, async () => {
      order.push('resource-write');
      return {
        result: 'updated',
        references: [{ reference, nextBytes: 30n, nextSha256: null }]
      };
    }, { beforeReferences: async () => { order.push('before-references'); } });

    expect(result).toBe('updated');
    expect(order[0]).toContain('FROM "users"');
    expect(order[0]).toContain('FOR SHARE');
    expect(order[1]).toContain('INSERT INTO "account_limits"');
    expect(order[2]).toContain('FROM "account_limits"');
    expect(order[2]).toContain('FOR UPDATE');
    expect(order[3]).toContain('INSERT INTO "storage_account_totals"');
    expect(order[4]).toContain('FROM "storage_account_totals"');
    expect(order[4]).toContain('FOR UPDATE');
    expect(order.indexOf('before-references')).toBeGreaterThan(order.findIndex((sql) => sql.includes('SAVEPOINT')));
    expect(order.indexOf('resource-write')).toBeGreaterThan(order.indexOf('before-references'));
    expect(order.indexOf('before-references')).toBeLessThan(order.findIndex((sql) => sql.includes('SELECT "byte_count"')));
    expect(order.some((sql) => sql.includes('UPDATE "storage_account_totals" SET "used_bytes"'))).toBe(true);
    expect(transaction.query).not.toHaveBeenCalledWith(expect.stringContaining('BEGIN'), expect.anything());
  });

  it('rolls back the quota savepoint when the pre-reference lock hook fails', async () => {
    const transaction = fakeQueryRunner(async (sql) => {
      if (sql.includes('FROM "users"')) return [{ id: OWNER_ID }];
      if (sql.includes('SELECT "storage_limit_bytes"')) return [{ storage_limit_bytes: '100' }];
      if (sql.includes('SELECT "used_bytes"')) return [{ used_bytes: '20', reserved_bytes: '0', accounting_state: 'ready' }];
      return [];
    });
    const repository = new TypeOrmStorageQuotaRepository({} as DataSource);
    const mutate = jest.fn(async () => ({ result: 'unreachable', references: [] }));
    const hookError = new Error('mapping lock unavailable');

    await expect(repository.runDatabaseMutation(
      transaction,
      { ownerId: OWNER_ID, maximumGrowthBytes: 0n },
      mutate,
      { beforeReferences: async () => { throw hookError; } }
    )).rejects.toBe(hookError);

    expect(mutate).not.toHaveBeenCalled();
    expect(transaction.query.mock.calls.some(([statement]) => String(statement).startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
  });

  it('rolls back only the quota mutation savepoint when exact post-write growth exceeds quota', async () => {
    const transaction = fakeQueryRunner(async (sql) => {
      if (sql.includes('FROM "users"')) return [{ id: OWNER_ID }];
      if (sql.includes('SELECT "storage_limit_bytes"')) return [{ storage_limit_bytes: '25' }];
      if (sql.includes('SELECT "used_bytes"')) return [{ used_bytes: '20', reserved_bytes: '5', accounting_state: 'ready' }];
      if (sql.includes('SELECT "byte_count"')) return [{ byte_count: '10', sha256: null }];
      return [];
    });
    const repository = new TypeOrmStorageQuotaRepository({} as DataSource);
    const reference = databaseReference();
    const mutate = jest.fn(async () => {
      await transaction.query('UPDATE "messages" SET "content" = $1', ['oversized']);
      return { result: 'never', references: [{ reference, nextBytes: 30n, nextSha256: null }] };
    });

    await expect(repository.runDatabaseMutation(transaction, { ownerId: OWNER_ID, maximumGrowthBytes: 20n }, mutate))
      .rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED', statusCode: 413 });
    expect(mutate).toHaveBeenCalledTimes(1);
    const sql = transaction.query.mock.calls.map(([statement]) => String(statement));
    expect(sql.some((statement) => statement.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
    expect(sql.some((statement) => statement.includes('UPDATE "storage_account_totals" SET "used_bytes"'))).toBe(false);
  });

  it('admits a database-content shrink while already above quota', async () => {
    const transaction = fakeQueryRunner(async (sql) => {
      if (sql.includes('FROM "users"')) return [{ id: OWNER_ID }];
      if (sql.includes('SELECT "storage_limit_bytes"')) return [{ storage_limit_bytes: '10' }];
      if (sql.includes('SELECT "used_bytes"')) return [{ used_bytes: '20', reserved_bytes: '0', accounting_state: 'ready' }];
      if (sql.includes('SELECT "byte_count"')) return [{ byte_count: '15', sha256: null }];
      return [];
    });
    const repository = new TypeOrmStorageQuotaRepository({} as DataSource);

    await expect(repository.runDatabaseMutation(transaction, { ownerId: OWNER_ID, maximumGrowthBytes: 0n }, async () => ({
      result: 'shrunk', references: [{ reference: databaseReference(), nextBytes: 5n, nextSha256: null }]
    }))).resolves.toBe('shrunk');
    expect(transaction.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "storage_account_totals" SET "used_bytes"'), [OWNER_ID, '10']
    );
  });

  it('persists an exact file growth reservation before returning to filesystem callers', async () => {
    const command = fileCommand();
    const runner = reservingRunner();
    const dataSource = { createQueryRunner: jest.fn(() => runner) } as unknown as DataSource;
    const repository = new TypeOrmStorageQuotaRepository(dataSource);

    await expect(repository.reserveFileOperation(command, resolveTrustedScope)).resolves.toMatchObject({
      operationId: 'reservation-1', state: 'reserved', outcome: null, replay: false
    });
    const sql = runner.query.mock.calls.map(([statement]) => String(statement));
    expect(sql[0]).toContain('FROM "users"');
    expect(sql[0]).toContain('FOR SHARE');
    expect(sql[1]).toContain('INSERT INTO "account_limits"');
    expect(sql[2]).toContain('FROM "account_limits"');
    expect(sql[2]).toContain('FOR UPDATE');
    expect(sql.findIndex((statement) => statement.includes('FROM "projects"')))
      .toBeLessThan(sql.findIndex((statement) => statement.includes('INSERT INTO "storage_filesystem_reservations"')));
    expect(sql.findIndex((statement) => statement.includes('INSERT INTO "storage_filesystem_reservations"')))
      .toBeLessThan(sql.findIndex((statement) => statement.includes('UPDATE "storage_account_totals" SET "reserved_bytes"')));
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
    const reservationCall = runner.query.mock.calls.find(([statement]) => String(statement).includes('INSERT INTO "storage_filesystem_reservations"'));
    expect(reservationCall?.[1]).toContain('5');
    const counterCall = runner.query.mock.calls.find(([statement]) => String(statement).includes('SET "reserved_bytes"'));
    expect(counterCall?.[1]).toEqual([OWNER_ID, '5']);
  });

  it('restores bigint outcome bytes when a settled file operation is replayed from PostgreSQL JSONB', async () => {
    const command = fileCommand();
    const outcome = [{
      kind: 'project_file', resourceKey: 'project-root', copyKey: 'notes.md', projectId: 'project-1',
      rootKey: 'managed:project-1', relativeKey: 'notes.md', bytes: '15', sha256: 'b'.repeat(64)
    }];
    const runner = fakeQueryRunner(async (sql) => {
      if (sql.includes('FROM "users"')) return [{ id: OWNER_ID }];
      if (sql.includes('SELECT "storage_limit_bytes"')) return [{ storage_limit_bytes: '100' }];
      if (sql.includes('SELECT "used_bytes"')) return [{ used_bytes: '25', reserved_bytes: '0', accounting_state: 'ready' }];
      if (sql.includes('SELECT "id", "fingerprint", "status"')) return [{
        id: 'reservation-1', fingerprint: command.fingerprint, status: 'settled', reserved_growth_bytes: '0',
        reference_changes: command.changes.map((change) => ({
          ...change,
          expectedPriorBytes: change.expectedPriorBytes?.toString() ?? null,
          intendedBytes: change.intendedBytes?.toString() ?? null
        })), outcome
      }];
      return [];
    });
    const repository = new TypeOrmStorageQuotaRepository({ createQueryRunner: jest.fn(() => runner) } as unknown as DataSource);

    await expect(repository.reserveFileOperation(command, resolveTrustedScope)).resolves.toMatchObject({
      operationId: 'reservation-1', state: 'settled', replay: true,
      outcome: [{ ...outcome[0], bytes: 15n }]
    });
  });

  it('settles a verified file write and releases its reservation in one transaction', async () => {
    const command = fileCommand();
    const reservationRow = storedReservation(command);
    const runner = settlementRunner(reservationRow);
    const repository = new TypeOrmStorageQuotaRepository({ createQueryRunner: jest.fn(() => runner) } as unknown as DataSource);
    const actual: StorageVerifiedFileChange = {
      kind: 'project_file', resourceKey: 'project-root', copyKey: 'notes.md', projectId: 'project-1',
      rootKey: 'managed:project-1', relativeKey: 'notes.md', bytes: 15n, sha256: 'b'.repeat(64)
    };

    await expect(repository.settleFileOperation(OWNER_ID, 'reservation-1', [actual])).resolves.toMatchObject({
      operationId: 'reservation-1', state: 'settled', outcome: [actual], replay: false
    });
    const totalUpdate = runner.query.mock.calls.find(([statement]) => String(statement).includes('SET "used_bytes" = $2, "reserved_bytes" = $3'));
    expect(totalUpdate?.[1]).toEqual([OWNER_ID, '25', '0', false]);
    expect(runner.query.mock.calls.some(([statement]) => String(statement).includes("SET \"status\" = 'settled'"))).toBe(true);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('accounts verified unexpected bytes, settles the reservation, and disables further growth for reconciliation', async () => {
    const command = fileCommand();
    const runner = settlementRunner(storedReservation(command));
    const repository = new TypeOrmStorageQuotaRepository({ createQueryRunner: jest.fn(() => runner) } as unknown as DataSource);
    const unexpected: StorageVerifiedFileChange = {
      kind: 'project_file', resourceKey: 'project-root', copyKey: 'notes.md', projectId: 'project-1',
      rootKey: 'managed:project-1', relativeKey: 'notes.md', bytes: 20n, sha256: 'c'.repeat(64)
    };

    await expect(repository.settleFileOperation(OWNER_ID, 'reservation-1', [unexpected]))
      .rejects.toMatchObject({ code: 'STORAGE_RECONCILIATION_PENDING', statusCode: 503 });
    const unavailable = runner.query.mock.calls.find(([statement]) => String(statement).includes('SET "used_bytes" = $2, "reserved_bytes" = $3'));
    expect(unavailable?.[1]).toEqual([OWNER_ID, '30', '0', true]);
    expect(runner.query.mock.calls.some(([statement]) => String(statement).includes("SET \"status\" = 'settled'"))).toBe(true);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('settles a verified no-op at the planned location without marking accounting unavailable', async () => {
    const command = fileCommand();
    const runner = settlementRunner(storedReservation(command));
    const repository = new TypeOrmStorageQuotaRepository({ createQueryRunner: jest.fn(() => runner) } as unknown as DataSource);
    const unchanged: StorageVerifiedFileChange = {
      kind: 'project_file', resourceKey: 'project-root', copyKey: 'notes.md', projectId: 'project-1',
      rootKey: 'managed:project-1', relativeKey: 'notes.md', bytes: 10n, sha256: 'a'.repeat(64)
    };

    await expect(repository.settleFileOperation(OWNER_ID, 'reservation-1', [unchanged])).resolves.toMatchObject({
      operationId: 'reservation-1', state: 'settled', outcome: [unchanged], replay: false
    });
    const totalUpdate = runner.query.mock.calls.find(([statement]) => String(statement).includes('SET "used_bytes" = $2, "reserved_bytes" = $3'));
    expect(totalUpdate?.[1]).toEqual([OWNER_ID, '20', '0', false]);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('releases purged recovery references for an inactive owner under the account and root locks', async () => {
    const runner = fakeQueryRunner(async (sql) => {
      if (sql.includes('FROM "users"')) return [{ id: OWNER_ID }];
      if (sql.includes('SELECT "storage_limit_bytes"')) return [{ storage_limit_bytes: '100' }];
      if (sql.includes('SELECT "used_bytes"')) return [{ used_bytes: '20', reserved_bytes: '0', accounting_state: 'ready' }];
      if (sql.includes('FROM "storage_filesystem_reservations"')) return [];
      if (sql.includes('FROM "storage_resource_references"')) return [{ byte_count: '5' }, { byte_count: '3' }];
      return [];
    });
    const repository = new TypeOrmStorageQuotaRepository({ createQueryRunner: jest.fn(() => runner) } as unknown as DataSource);

    await expect(repository.releaseRecoveryReferencesAfterVerifiedPurge(OWNER_ID, 'project-1', ['run-1', 'run-2'])).resolves.toBeUndefined();

    const sql = runner.query.mock.calls.map(([statement]) => String(statement));
    expect(sql[0]).toContain('FROM "users"');
    expect(sql[0]).not.toContain('\"is_active\"');
    expect(sql.find((statement) => statement.includes('pg_advisory_xact_lock'))).toBeDefined();
    expect(sql.some((statement) => statement.includes("'recovery_file'") && statement.includes('FOR UPDATE'))).toBe(true);
    expect(runner.query.mock.calls.find(([statement]) => String(statement).includes('SET "used_bytes" = $2'))?.[1])
      .toEqual([OWNER_ID, '12']);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
  });
});

function databaseReference() {
  return {
    ownerId: OWNER_ID, kind: 'database_content' as const, resourceKey: 'project-1', copyKey: 'project-name', bytes: 10n,
    projectId: 'project-1', rootKey: null, relativeKey: null, sha256: null
  };
}

function fileCommand(): StorageFileOperationCommand {
  const base: Omit<StorageFileOperationCommand, 'fingerprint'> = {
    ownerId: OWNER_ID,
    operationKey: 'mutation-1',
    projectId: 'project-1',
    rootKey: 'managed:project-1',
    targetKey: 'notes.md',
    changes: [{
      kind: 'project_file', resourceKey: 'project-root', copyKey: 'notes.md', projectId: 'project-1',
      rootKey: 'managed:project-1', relativeKey: 'notes.md', expectedPriorBytes: 10n,
      expectedPriorSha256: 'a'.repeat(64), intendedBytes: 15n, intendedSha256: 'b'.repeat(64)
    }]
  };
  return { ...base, fingerprint: storageFileOperationFingerprint(base) };
}

const resolveTrustedScope = jest.fn(async (transaction: StorageQuotaTransaction) => {
  await transaction.query('SELECT "id", "relative_root", "storage_kind" FROM "projects" FOR SHARE');
  return {
    ownerId: OWNER_ID,
    projectId: 'project-1',
    roots: [{ ownerId: OWNER_ID, projectId: 'project-1', locatorProjectId: 'project-1', rootKey: 'managed:project-1', storageKind: 'managed' as const, relativeRoot: 'projects/project-1' }]
  };
});

function reservingRunner(): QueryRunner & { query: jest.Mock; commitTransaction: jest.Mock; release: jest.Mock } {
  return fakeQueryRunner(async (sql) => {
    if (sql.includes('FROM "users"')) return [{ id: OWNER_ID }];
    if (sql.includes('SELECT "storage_limit_bytes"')) return [{ storage_limit_bytes: '100' }];
    if (sql.includes('SELECT "used_bytes"')) return [{ used_bytes: '20', reserved_bytes: '0', accounting_state: 'ready' }];
    if (sql.includes('SELECT "id", "fingerprint", "status"')) return [];
    if (sql.includes('SELECT "byte_count"')) return [{ byte_count: '10', sha256: 'a'.repeat(64) }];
    if (sql.includes('INSERT INTO "storage_filesystem_reservations"')) return [{ id: 'reservation-1' }];
    return [];
  });
}

function storedReservation(command: StorageFileOperationCommand): Record<string, unknown> {
  return {
    id: 'reservation-1', fingerprint: command.fingerprint, status: 'pending', reserved_growth_bytes: '5',
    reference_changes: command.changes.map((change) => ({
      ...change,
      expectedPriorBytes: change.expectedPriorBytes?.toString() ?? null,
      intendedBytes: change.intendedBytes?.toString() ?? null
    })),
    outcome: null
  };
}

function settlementRunner(reservation: Record<string, unknown>): QueryRunner & { query: jest.Mock; commitTransaction: jest.Mock; release: jest.Mock } {
  return fakeQueryRunner(async (sql) => {
    if (sql.includes('SELECT "storage_limit_bytes"')) return [{ storage_limit_bytes: '100' }];
    if (sql.includes('SELECT "used_bytes"')) return [{ used_bytes: '20', reserved_bytes: '5', accounting_state: 'ready' }];
    if (sql.includes('SELECT "id", "fingerprint", "status"')) return [reservation];
    if (sql.includes('SELECT "byte_count"')) return [{ byte_count: '10', sha256: 'a'.repeat(64) }];
    return [];
  });
}

function fakeQueryRunner(
  resolve: (sql: string, parameters: unknown[] | undefined) => Promise<unknown> | unknown
): QueryRunner & { query: jest.Mock; commitTransaction: jest.Mock; release: jest.Mock } {
  const query = jest.fn(async (sql: string, parameters?: unknown[]) => await resolve(sql, parameters));
  return {
    query,
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    isTransactionActive: true
  } as unknown as QueryRunner & { query: jest.Mock; commitTransaction: jest.Mock; release: jest.Mock };
}
