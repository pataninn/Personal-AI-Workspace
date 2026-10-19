import { storageFileOperationFingerprint } from '@/modules/storage-quotas/domain/storage-file-operation-fingerprint';
import type { StorageFileOperationCommand } from '@/modules/storage-quotas/domain/storage-quota-types';

describe('storageFileOperationFingerprint', () => {
  const command: Omit<StorageFileOperationCommand, 'fingerprint'> = {
    ownerId: 'owner-1', operationKey: 'operation-1', projectId: 'project-1', rootKey: 'managed:project-1', targetKey: 'notes.md',
    changes: [{
      kind: 'project_file', resourceKey: 'notes.md', copyKey: 'live', projectId: 'project-1', rootKey: 'managed:project-1',
      relativeKey: 'notes.md', expectedPriorBytes: null, expectedPriorSha256: null, intendedBytes: 7n,
      intendedSha256: 'a'.repeat(64)
    }]
  };

  it('is deterministic and changes when a persisted effect changes', () => {
    expect(storageFileOperationFingerprint(command)).toBe(storageFileOperationFingerprint(command));
    expect(storageFileOperationFingerprint({ ...command, changes: [...command.changes].reverse() })).toBe(storageFileOperationFingerprint(command));
    expect(storageFileOperationFingerprint({
      ...command,
      changes: [{ ...command.changes[0]!, intendedBytes: 8n }]
    })).not.toBe(storageFileOperationFingerprint(command));
  });
});
