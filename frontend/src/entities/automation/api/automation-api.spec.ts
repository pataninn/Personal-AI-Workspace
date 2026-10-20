import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAutomationSchedule, listAutomationOccurrences, runAutomationNow, updateAutomationSchedule } from '@/entities/automation';

const SCHEDULE_ID = '11111111-1111-4111-8111-111111111111';
const fetchMock = vi.fn<typeof fetch>();

describe('automation API', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends create and update using the exact owner-scoped payload and revision', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ schedule: { id: SCHEDULE_ID } }));
    await createAutomationSchedule({
      workspaceId: '22222222-2222-4222-8222-222222222222', skillId: '33333333-3333-4333-8333-333333333333',
      skillVersion: 4, localTime: '08:30', timeZone: 'Asia/Shanghai'
    }, 'csrf-token', 'create-key-0001');
    const [createPath, createRequest] = fetchMock.mock.calls[0] ?? [];
    expect(createPath).toBe('/api/v1/automations/schedules');
    expect(createRequest?.method).toBe('POST');
    expect(JSON.parse(String(createRequest?.body))).toEqual({
      workspaceId: '22222222-2222-4222-8222-222222222222', skillId: '33333333-3333-4333-8333-333333333333',
      skillVersion: 4, localTime: '08:30', timeZone: 'Asia/Shanghai'
    });
    expect(new Headers(createRequest?.headers).get('Idempotency-Key')).toBe('create-key-0001');
    expect(new Headers(createRequest?.headers).get('X-CSRF-Token')).toBe('csrf-token');

    fetchMock.mockResolvedValueOnce(envelope({ schedule: { id: SCHEDULE_ID } }));
    await updateAutomationSchedule(SCHEDULE_ID, { expectedRevision: 7, enabled: false }, 'csrf-token');
    const [updatePath, updateRequest] = fetchMock.mock.calls[1] ?? [];
    expect(updatePath).toBe(`/api/v1/automations/schedules/${SCHEDULE_ID}`);
    expect(updateRequest?.method).toBe('PATCH');
    expect(JSON.parse(String(updateRequest?.body))).toEqual({ expectedRevision: 7, enabled: false });
    expect(new Headers(updateRequest?.headers).get('X-CSRF-Token')).toBe('csrf-token');
  });

  it('uses the strict empty Run now payload and the delivered bounded occurrence cursor', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ occurrence: { id: '55555555-5555-4555-8555-555555555555' } }));
    await runAutomationNow(SCHEDULE_ID, 'csrf-token', 'run-key-0001');
    const [runPath, runRequest] = fetchMock.mock.calls[0] ?? [];
    expect(runPath).toBe(`/api/v1/automations/schedules/${SCHEDULE_ID}/runs`);
    expect(runRequest?.method).toBe('POST');
    expect(JSON.parse(String(runRequest?.body))).toEqual({});
    expect(new Headers(runRequest?.headers).get('Idempotency-Key')).toBe('run-key-0001');

    fetchMock.mockResolvedValueOnce(envelope({ occurrences: [], nextCursor: null }));
    await listAutomationOccurrences(SCHEDULE_ID, 'opaque + cursor');
    const [historyPath, historyRequest] = fetchMock.mock.calls[1] ?? [];
    expect(historyPath).toBe(`/api/v1/automations/schedules/${SCHEDULE_ID}/occurrences?limit=50&before=opaque+%2B+cursor`);
    expect(historyRequest?.method).toBe('GET');
  });
});

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
