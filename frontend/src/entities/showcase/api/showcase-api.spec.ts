import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCurrentShowcase } from '@/entities/showcase/api/showcase-api';

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
});
