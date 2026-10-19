import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDemoAdmissionKey, createDemoSession, getDemoAvailability, getDemoShowcaseCopy } from '@/entities/demo';

describe('demo API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates the 43-character base64url key required for anonymous admission', () => {
    const key = createDemoAdmissionKey();

    expect(key).toHaveLength(43);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('checks public availability without sending the current session cookie', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: { available: false }, error: null }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getDemoAvailability()).resolves.toEqual({ available: false });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/demo/availability', {
      credentials: 'omit',
      headers: { Accept: 'application/json' }
    });
  });

  it('keeps a cookie-less idempotency replay status-only', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: { state: 'ready' }, error: null }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createDemoSession('a'.repeat(43))).resolves.toEqual({ state: 'ready' });

    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.body).toBe('{}');
    expect(new Headers(options?.headers).get('Idempotency-Key')).toBe('a'.repeat(43));
  });

  it('requires a private UUID target only for ready copy status', async () => {
    const ready = { state: 'ready', projectId: '11111111-1111-4111-8111-111111111111', retryAllowed: false, workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false } };
    const pending = { state: 'pending', projectId: null, retryAllowed: false, workspaceMode: null, capabilities: null };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: ready, error: null }))
      .mockResolvedValueOnce(jsonResponse({ data: pending, error: null }))
      .mockResolvedValueOnce(jsonResponse({ data: { ...ready, projectId: null }, error: null }))
      .mockResolvedValueOnce(jsonResponse({ data: { ...pending, projectId: ready.projectId }, error: null }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getDemoShowcaseCopy()).resolves.toMatchObject({ state: 'ready', projectId: ready.projectId });
    await expect(getDemoShowcaseCopy()).resolves.toMatchObject({ state: 'pending', projectId: null });
    await expect(getDemoShowcaseCopy()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(getDemoShowcaseCopy()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
