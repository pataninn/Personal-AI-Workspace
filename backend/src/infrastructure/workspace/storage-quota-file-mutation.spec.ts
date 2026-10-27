import {
  StorageQuotaError
} from '@/modules/storage-quotas/domain/storage-quota-errors';
import type { IStorageQuotaRepository } from '@/modules/storage-quotas/repositories/storage-quota-repository';
import type { StorageFileOperationCommand, StorageFileOperationReservation, StorageTrustedFileScope, StorageVerifiedFileChange } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { StorageTrustedFileScopeResolver } from '@/modules/storage-quotas/repositories/storage-quota-repository';
import { StorageQuotaFileMutation, StorageQuotaKnownOutcomeError, StorageQuotaNoSideEffectError } from '@/infrastructure/workspace/storage-quota-file-mutation';

const change: StorageVerifiedFileChange = {
  kind: 'project_file', resourceKey: 'project-root', copyKey: 'notes.md', projectId: 'project-1', rootKey: 'managed:project-1',
  relativeKey: 'notes.md', bytes: 5n, sha256: 'a'.repeat(64)
};

const command: StorageFileOperationCommand = {
  ownerId: 'owner-1', operationKey: 'file-write-1', fingerprint: 'b'.repeat(64), projectId: 'project-1',
  rootKey: 'managed:project-1', targetKey: 'notes.md', changes: []
};

const trustedScope: StorageTrustedFileScope = {
  ownerId: 'owner-1', projectId: 'project-1',
  roots: [{ ownerId: 'owner-1', projectId: 'project-1', locatorProjectId: 'project-1', rootKey: 'managed:project-1', storageKind: 'managed', relativeRoot: 'projects/project-1' }]
};
const resolveTrustedScope: StorageTrustedFileScopeResolver = async () => trustedScope;

function fixture(reservation: StorageFileOperationReservation = {
  operationId: 'operation-1', state: 'reserved', outcome: null, replay: false, trustedScope
}) {
  const order: string[] = [];
  const storage = {
    reserveFileOperation: jest.fn(async () => { order.push('reserve'); return reservation; }),
    settleFileOperation: jest.fn(async () => {
      order.push('settle');
      return { operationId: 'operation-1', state: 'settled', outcome: [change], replay: false };
    }),
    releaseFileOperationWithNoSideEffect: jest.fn(async () => { order.push('release'); }),
    markFileOperationUnknown: jest.fn(async () => { order.push('unknown'); }),
  } as unknown as IStorageQuotaRepository;
  return { storage, order, coordinator: new StorageQuotaFileMutation(storage) };
}

describe('StorageQuotaFileMutation', () => {
  it('commits a reservation before filesystem work and settles verified effects afterward', async () => {
    const { coordinator, order } = fixture();
    await expect(coordinator.execute(command, resolveTrustedScope, async (scope) => {
      order.push('filesystem');
      expect(scope).toEqual(trustedScope);
      return { result: 'written', changes: [change] };
    })).resolves.toEqual({ state: 'applied', operationId: 'operation-1', result: 'written', replay: false });
    expect(order).toEqual(['reserve', 'filesystem', 'settle']);
  });

  it('releases only an explicitly proven no-side-effect failure', async () => {
    const { coordinator, order } = fixture();
    const originalError = new Error('validation failed before file access');
    const failure = new StorageQuotaNoSideEffectError(originalError);
    await expect(coordinator.execute(command, resolveTrustedScope, async () => {
      order.push('filesystem');
      throw failure;
    })).rejects.toBe(originalError);
    expect(order).toEqual(['reserve', 'filesystem', 'release']);
  });

  it('settles verified actual file state before returning the original operation failure', async () => {
    const { coordinator, order, storage } = fixture();
    const staleError = new Error('source changed during claim');
    await expect(coordinator.execute(command, resolveTrustedScope, async () => {
      order.push('filesystem');
      throw new StorageQuotaKnownOutcomeError(staleError, [change]);
    })).rejects.toBe(staleError);
    expect(storage.settleFileOperation).toHaveBeenCalledWith('owner-1', 'operation-1', [change]);
    expect(order).toEqual(['reserve', 'filesystem', 'settle']);
    expect(storage.markFileOperationUnknown).not.toHaveBeenCalled();
  });

  it('keeps a failed release pending when a no-side-effect reservation cannot be cleared', async () => {
    const { coordinator, order, storage } = fixture();
    (storage.releaseFileOperationWithNoSideEffect as jest.Mock).mockImplementationOnce(async () => {
      order.push('release-failed');
      throw new Error('database outcome unknown');
    });

    await expect(coordinator.execute(command, resolveTrustedScope, async () => {
      order.push('filesystem');
      throw new StorageQuotaNoSideEffectError();
    })).rejects.toMatchObject({ code: 'STORAGE_RECONCILIATION_PENDING', details: { operationId: 'operation-1' } });
    expect(order).toEqual(['reserve', 'filesystem', 'release-failed', 'unknown']);
  });

  it('keeps ambiguous outcomes reserved and returns an opaque pending error', async () => {
    const { coordinator, order } = fixture();
    await expect(coordinator.execute(command, resolveTrustedScope, async () => {
      order.push('filesystem');
      throw new Error('unknown write outcome');
    })).rejects.toMatchObject({ code: 'STORAGE_RECONCILIATION_PENDING', statusCode: 503, details: { operationId: 'operation-1' } });
    expect(order).toEqual(['reserve', 'filesystem', 'unknown']);
  });

  it('never repeats an already pending operation', async () => {
    const { coordinator, order } = fixture({ operationId: 'operation-1', state: 'unknown', outcome: null, replay: true });
    const apply = jest.fn(async () => ({ result: 'never', changes: [change] }));
    await expect(coordinator.execute(command, resolveTrustedScope, apply)).rejects.toBeInstanceOf(StorageQuotaError);
    expect(apply).not.toHaveBeenCalled();
    expect(order).toEqual(['reserve']);
  });

  it('returns the prior verified changes when an operation is settled already', async () => {
    const { coordinator, order } = fixture({ operationId: 'operation-1', state: 'settled', outcome: [change], replay: true });
    const apply = jest.fn(async () => ({ result: 'never', changes: [change] }));
    await expect(coordinator.execute(command, resolveTrustedScope, apply)).resolves.toEqual({ state: 'settled', operationId: 'operation-1', changes: [change], replay: true });
    expect(apply).not.toHaveBeenCalled();
    expect(order).toEqual(['reserve']);
  });
});
