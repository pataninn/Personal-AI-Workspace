import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listAiRunActivity, getAiRunActivity } from '@/entities/ai-run/api/activity-api';
import { ApiClientError } from '@/shared/api';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const item = {
  runId: RUN_ID, projectId: PROJECT_ID, conversationId: '33333333-3333-4333-8333-333333333333', status: 'succeeded', decision: 'approved', providerTransmission: 'transmitted_confirmed',
  createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:02.000Z', provider: 'NVIDIA hosted NIM', model: 'test-model', requestPreview: 'Review the project.',
  context: { categories: ['Request'], fileCount: 0, factCount: 0, messageCount: 0, estimatedTokens: 8 },
  usage: { status: 'partial', promptTokens: 8, completionTokens: null, totalTokens: null },
  cost: { status: 'unavailable', label: 'Unavailable — no rate configured' }, changeSet: null
} as const;
const fetchMock = vi.fn<typeof fetch>();

describe('AI run activity API', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('requests a bounded project page and normalizes partial provider usage', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ projectId: PROJECT_ID, items: [item], nextCursor: 'next-page' }));

    await expect(listAiRunActivity(PROJECT_ID, 'attention', 'opaque-cursor')).resolves.toEqual({ projectId: PROJECT_ID, items: [item], nextCursor: 'next-page' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${PROJECT_ID}/ai-runs?limit=20&filter=attention&cursor=opaque-cursor`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'include' });
  });

  it('rejects a response for a different project and malformed token counts', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ projectId: 'other-project', items: [], nextCursor: null }));
    await expect(listAiRunActivity(PROJECT_ID, 'all')).rejects.toBeInstanceOf(ApiClientError);

    fetchMock.mockResolvedValueOnce(envelope({ projectId: PROJECT_ID, items: [{ ...item, usage: { ...item.usage, promptTokens: 1.5 } }], nextCursor: null }));
    await expect(listAiRunActivity(PROJECT_ID, 'all')).rejects.toBeInstanceOf(ApiClientError);
  });

  it('loads only bounded detail fields and validates run identity', async () => {
    const detail = { ...item, assistantPreview: 'Safe answer.', selectedFiles: ['src/app.ts'], selectedFactTitles: ['Project goal'], operations: [], omittedOperationCount: 0 };
    fetchMock.mockResolvedValueOnce(envelope(detail));

    await expect(getAiRunActivity(RUN_ID)).resolves.toMatchObject({ assistantPreview: 'Safe answer.', selectedFiles: ['src/app.ts'] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/ai-runs/${RUN_ID}/activity`);

    fetchMock.mockResolvedValueOnce(envelope({ ...detail, runId: 'other-run' }));
    await expect(getAiRunActivity(RUN_ID)).rejects.toBeInstanceOf(ApiClientError);
  });
});

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
