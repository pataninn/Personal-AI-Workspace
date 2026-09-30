import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listProjectFileHistory } from '@/entities/ai-run/api/file-history-api';
import { ApiClientError } from '@/shared/api';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const item = {
  changeSetId: '33333333-3333-4333-8333-333333333333', projectId: PROJECT_ID, runId: RUN_ID, conversationId: null,
  operationId: '44444444-4444-4444-8444-444444444444', operationIndex: 0, operation: 'rename', matchedPath: 'src/new.ts',
  path: 'src/old.ts', destinationPath: 'src/new.ts', summary: 'Rename module', changeSetStatus: 'stale',
  operationStatus: 'skipped', backupStatus: 'created', createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:01:00.000Z'
};
const fetchMock = vi.fn<typeof fetch>();

describe('project file history API', () => {
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('requests an encoded project and path scoped page with the selected outcome', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { projectId: PROJECT_ID, path: 'src/new.ts', outcome: 'all', items: [item], nextCursor: 'next' }, error: null }), { status: 200 }));
    await expect(listProjectFileHistory(PROJECT_ID, 'src/new.ts', 'all')).resolves.toMatchObject({ projectId: PROJECT_ID, path: 'src/new.ts', items: [item], nextCursor: 'next' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${PROJECT_ID}/file-history?path=src%2Fnew.ts&outcome=all&limit=20`);
  });

  it('rejects cross-project, cross-path, and malformed operation outcomes', async () => {
    const response = (data: unknown): Response => new Response(JSON.stringify({ data, error: null }), { status: 200 });
    fetchMock.mockResolvedValueOnce(response({ projectId: 'other', path: 'src/new.ts', outcome: 'all', items: [], nextCursor: null }));
    await expect(listProjectFileHistory(PROJECT_ID, 'src/new.ts', 'all')).rejects.toBeInstanceOf(ApiClientError);
    fetchMock.mockResolvedValueOnce(response({ projectId: PROJECT_ID, path: 'src/new.ts', outcome: 'all', items: [{ ...item, matchedPath: 'src/other.ts' }], nextCursor: null }));
    await expect(listProjectFileHistory(PROJECT_ID, 'src/new.ts', 'all')).rejects.toBeInstanceOf(ApiClientError);
    fetchMock.mockResolvedValueOnce(response({ projectId: PROJECT_ID, path: 'src/new.ts', outcome: 'all', items: [{ ...item, backupStatus: 'backup-secret-path' }], nextCursor: null }));
    await expect(listProjectFileHistory(PROJECT_ID, 'src/new.ts', 'all')).rejects.toBeInstanceOf(ApiClientError);
  });
});
