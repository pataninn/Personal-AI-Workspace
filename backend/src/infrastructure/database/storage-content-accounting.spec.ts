import type { DataSource } from 'typeorm';

import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import type {
  IStorageQuotaRepository,
  StorageDatabaseMutationResult,
  StorageQuotaTransaction
} from '@/modules/storage-quotas/repositories/storage-quota-repository';
import type {
  StorageFileOperationReservation,
  StorageResourceReference,
  StorageResourceReferenceChange,
  StorageUsageSnapshot,
  StorageUnresolvedFileOperation
} from '@/modules/storage-quotas/domain/storage-quota-types';
import type { StorageContentIdentity } from '@/infrastructure/database/storage-content-projections';
import { scanContentIdentities } from '@/infrastructure/database/storage-content-projections';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';

function unused<T>(): Promise<T> {
  return Promise.reject(new Error('This storage operation is not used by the accounting fixture.'));
}

function storageRepository(): IStorageQuotaRepository & {
  readonly capturedReferences: { current: readonly StorageResourceReferenceChange[] };
  readonly calls: {
    readonly transaction: StorageQuotaTransaction;
    readonly input: { readonly ownerId: string; readonly maximumGrowthBytes: bigint };
  }[];
} {
  const capturedReferences: { current: readonly StorageResourceReferenceChange[] } = { current: [] };
  const calls: {
    readonly transaction: StorageQuotaTransaction;
    readonly input: { readonly ownerId: string; readonly maximumGrowthBytes: bigint };
  }[] = [];
  return {
    readUsage: async (_ownerId: string): Promise<StorageUsageSnapshot> => unused(),
    runDatabaseMutation: async <T>(
      _transaction: StorageQuotaTransaction,
      _input: { readonly ownerId: string; readonly maximumGrowthBytes: bigint },
      mutate: () => Promise<StorageDatabaseMutationResult<T>>
    ): Promise<T> => {
      calls.push({ transaction: _transaction, input: _input });
      const outcome = await mutate();
      capturedReferences.current = outcome.references;
      return outcome.result;
    },
    reserveFileOperation: async (): Promise<StorageFileOperationReservation> => unused(),
    listUnresolvedFileOperations: async (): Promise<readonly StorageUnresolvedFileOperation[]> => unused(),
    settleFileOperation: async (): Promise<StorageFileOperationReservation> => unused(),
    releaseFileOperationWithNoSideEffect: async (): Promise<void> => unused(),
    markFileOperationUnknown: async (): Promise<void> => unused(),
    reconcileReferences: async (_ownerId: string, _references: readonly StorageResourceReference[]): Promise<void> => unused(),
    markAccountUnavailable: async (_ownerId: string): Promise<void> => unused(),
    capturedReferences,
    calls
  };
}

describe('TypeOrmStorageContentAccounting', () => {
  it('measures canonical retained content in PostgreSQL and returns stable per-copy references', async () => {
    const query = jest.fn().mockResolvedValue([
      { resource_key: 'messages:message-id', copy_key: 'content', project_id: 'project-id', byte_count: '9' },
      { resource_key: 'projects:project-id', copy_key: 'name', project_id: null, byte_count: '12' }
    ]);
    const accounting = new TypeOrmStorageContentAccounting({} as DataSource, storageRepository());

    const references = await accounting.scanDatabaseContent({ query } as unknown as StorageQuotaTransaction, OWNER_ID);

    expect(query.mock.calls[0]?.[0]).toContain('octet_length(m."content")');
    expect(query.mock.calls[0]?.[0]).toContain('octet_length(k."request_fingerprint")');
    expect(query.mock.calls[0]?.[0]).toContain('octet_length(r."manifest"::text)');
    expect(query.mock.calls[0]?.[1]).toEqual([OWNER_ID]);
    expect(references).toEqual([
      {
        ownerId: OWNER_ID, kind: 'database_content', resourceKey: 'messages:message-id', copyKey: 'content',
        bytes: 9n, projectId: 'project-id', rootKey: null, relativeKey: null, sha256: null
      },
      {
        ownerId: OWNER_ID, kind: 'database_content', resourceKey: 'projects:project-id', copyKey: 'name',
        bytes: 12n, projectId: null, rootKey: null, relativeKey: null, sha256: null
      }
    ]);
  });

  it('projects only the selected conversation request fingerprint by its UUID', async () => {
    const query = jest.fn().mockResolvedValue([{
      resource_key: 'conversation_idempotency_keys:request-id',
      copy_key: 'request_fingerprint',
      project_id: 'project-id',
      byte_count: '37'
    }]);
    const transaction = { query } as unknown as StorageQuotaTransaction;

    const references = await scanContentIdentities(transaction, OWNER_ID, [
      { entity: 'conversation_idempotency_keys', id: 'request-id' }
    ]);

    expect(query.mock.calls[0]?.[0]).toContain('FROM "conversation_idempotency_keys"');
    expect(query.mock.calls[0]?.[0]).toContain('"id" = ANY($2::uuid[])');
    expect(query.mock.calls[0]?.[1]).toEqual([OWNER_ID, ['request-id']]);
    expect(references).toEqual([{
      ownerId: OWNER_ID,
      kind: 'database_content',
      resourceKey: 'conversation_idempotency_keys:request-id',
      copyKey: 'request_fingerprint',
      bytes: 37n,
      projectId: 'project-id',
      rootKey: null,
      relativeKey: null,
      sha256: null
    }]);
  });

  it('accounts for each retained skill revision field under its workspace scope', async () => {
    const query = jest.fn().mockResolvedValue([
      { resource_key: 'skill_revisions:revision-id', copy_key: 'title', project_id: 'project-id', byte_count: '12' },
      { resource_key: 'skill_revisions:revision-id', copy_key: 'instructions', project_id: 'project-id', byte_count: '30' },
      { resource_key: 'skill_revisions:revision-id', copy_key: 'declared_tools', project_id: 'project-id', byte_count: '18' }
    ]);
    const transaction = { query } as unknown as StorageQuotaTransaction;

    const references = await scanContentIdentities(transaction, OWNER_ID, [
      { entity: 'skill_revisions', id: 'revision-id' }
    ]);

    expect(query.mock.calls[0]?.[0]).toContain('FROM "skill_revisions" r JOIN "skills" s');
    expect(query.mock.calls[0]?.[0]).toContain('octet_length(r."instructions")');
    expect(query.mock.calls[0]?.[1]).toEqual([OWNER_ID, ['revision-id']]);
    expect(references.map(({ resourceKey, copyKey, bytes, projectId }) => [resourceKey, copyKey, bytes, projectId])).toEqual([
      ['skill_revisions:revision-id', 'title', 12n, 'project-id'],
      ['skill_revisions:revision-id', 'instructions', 30n, 'project-id'],
      ['skill_revisions:revision-id', 'declared_tools', 18n, 'project-id']
    ]);
  });

  it('sends only new, changed, and deleted copies through the same transaction quota mutation', async () => {
    const priorReferences = [
      { resource_key: 'project_facts:fact-id', copy_key: 'content', project_id: 'project-id', byte_count: '4', root_key: null, relative_key: null, sha256: null },
      { resource_key: 'messages:removed-id', copy_key: 'content', project_id: 'project-id', byte_count: '8', root_key: null, relative_key: null, sha256: null }
    ];
    const query = jest.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('storage_resource_references')) {
        expect(sql).not.toContain('FOR UPDATE');
        expect(parameters?.[1]).toEqual(expect.arrayContaining(['project_facts:fact-id', 'messages:removed-id', 'messages:new-id']));
        return priorReferences;
      }
      if (sql.includes('FROM "project_facts"')) {
        expect(sql).toContain('"id" = ANY($2::uuid[])');
        expect(parameters?.[1]).toEqual(['fact-id']);
        return [{ resource_key: 'project_facts:fact-id', copy_key: 'content', project_id: 'project-id', byte_count: '7' }];
      }
      if (sql.includes('FROM "messages"')) {
        expect(sql).toContain('"id" = ANY($2::uuid[])');
        expect(parameters?.[1]).toEqual(['removed-id', 'new-id']);
        return [{ resource_key: 'messages:new-id', copy_key: 'content', project_id: 'project-id', byte_count: '5' }];
      }
      throw new Error(`Unexpected scoped accounting query: ${sql}`);
    });
    const repository = storageRepository();
    const accounting = new TypeOrmStorageContentAccounting({} as DataSource, repository);
    const transaction = { query } as unknown as StorageQuotaTransaction;

    const before: readonly StorageContentIdentity[] = [
      { entity: 'project_facts', id: 'fact-id' },
      { entity: 'messages', id: 'removed-id' }
    ];
    const after: readonly StorageContentIdentity[] = [
      { entity: 'project_facts', id: 'fact-id' },
      { entity: 'messages', id: 'new-id' }
    ];
    const result = await accounting.runMutation(transaction, OWNER_ID, async () => 'committed result', {
      before: async () => before,
      after: async () => after
    });

    expect(result).toBe('committed result');
    expect(repository.calls).toEqual([{
      transaction,
      input: { ownerId: OWNER_ID, maximumGrowthBytes: 9_223_372_036_854_775_807n }
    }]);
    expect(repository.capturedReferences.current.map((change) => [
      change.reference.resourceKey, change.reference.copyKey, change.nextBytes
    ])).toEqual([
      ['project_facts:fact-id', 'content', 7n],
      ['messages:removed-id', 'content', null],
      ['messages:new-id', 'content', 5n]
    ]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.map(([sql]) => sql).join('\n')).not.toContain('FROM "action_ledger_records"');
  });

  it('fails closed when a mutation omits every content identity', async () => {
    const accounting = new TypeOrmStorageContentAccounting({} as DataSource, storageRepository());
    await expect(accounting.runMutation({ query: jest.fn() } as unknown as StorageQuotaTransaction, OWNER_ID, async () => undefined, {
      before: async () => [], after: async () => []
    })).rejects.toThrow('must name every changed content identity');
  });
});
