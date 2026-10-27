import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCurrentShowcase, previewShowcase } from '@/entities/showcase/api/showcase-api';

function publicResponse(data: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data, error: null })
  } as Response;
}

describe('showcase public API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('normalizes the public skill projection and tolerates older snapshots without skills', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(publicResponse({
        version: '33333333-3333-4333-8333-333333333333',
        publishedAt: '2026-10-19T00:00:00.000Z',
        project: { name: 'Sample', objective: null },
        tasks: [], facts: [], files: [],
        skills: [{
          id: '44444444-4444-4444-8444-444444444444',
          title: 'Daily review', instructions: 'Summarize open tasks.', declaredTools: ['home_task_read']
        }]
      }))
      .mockResolvedValueOnce(publicResponse({
        version: '33333333-3333-4333-8333-333333333333',
        publishedAt: '2026-10-19T00:00:00.000Z',
        project: { name: 'Older snapshot', objective: null },
        tasks: [], facts: [], files: []
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCurrentShowcase()).resolves.toMatchObject({
      skills: [{
        id: '44444444-4444-4444-8444-444444444444',
        title: 'Daily review', instructions: 'Summarize open tasks.', declaredTools: ['home_task_read']
      }]
    });
    await expect(getCurrentShowcase()).resolves.toMatchObject({ skills: [] });
  });

  it('normalizes the server-reviewed skill preview without source identity fields', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(publicResponse({
      project: { name: 'Sample', objective: null }, tasks: [], facts: [],
      skills: [{ title: 'Plan helper', instructions: 'Prioritize open work.', declaredTools: ['home_task_read'] }],
      files: [], previewDigest: 'a'.repeat(64), sourceRevision: 'b'.repeat(64),
      totals: { itemCount: 1, fileCount: 0, snapshotBytes: 10 }, exclusions: []
    })));

    await expect(previewShowcase({ projectId: '11111111-1111-4111-8111-111111111111', selection: { taskIds: [], factIds: [], skillIds: [], filePaths: [] } }, 'csrf'))
      .resolves.toMatchObject({ skills: [{ title: 'Plan helper', instructions: 'Prioritize open work.', declaredTools: ['home_task_read'] }] });
  });
});
