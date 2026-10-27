import { databaseContentChange, databaseTextBytes } from '@/infrastructure/database/storage-content-references';

describe('database content references', () => {
  it('keeps an exact UTF-8 byte count and stable retained-copy identity', () => {
    expect(databaseTextBytes('你好🙂')).toBe(10n);
    expect(databaseContentChange({
      ownerId: 'owner', resourceTable: 'messages', resourceId: 'message-id', copyKey: 'content',
      nextBytes: '10', projectId: 'project-id'
    })).toEqual({
      reference: {
        ownerId: 'owner', kind: 'database_content', resourceKey: 'messages:message-id', copyKey: 'content',
        bytes: 10n, projectId: 'project-id', rootKey: null, relativeKey: null, sha256: null
      },
      nextBytes: 10n,
      nextSha256: null
    });
  });

  it('rejects nonrepresentable storage references before query execution', () => {
    expect(() => databaseContentChange({
      ownerId: 'owner', resourceTable: 'messages', resourceId: 'message-id', copyKey: 'content',
      nextBytes: -1n
    })).toThrow(RangeError);
  });
});
