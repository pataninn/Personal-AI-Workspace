import { describe, expect, it, vi } from 'vitest';

import { ApiClientError, getJson, postNoContent } from '@/shared/api/api-client';
import { registerSessionExpiryHandler } from '@/shared/api/session-expiry';

describe('getJson', () => {
  it('returns data from a successful API envelope', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ data: { status: 'ok' }, error: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));

    await expect(getJson<{ status: string }>('/health', fetchImplementation)).resolves.toEqual({ status: 'ok' });
    expect(fetchImplementation).toHaveBeenCalledWith('/health', expect.objectContaining({ credentials: 'include' }));
  });

  it('maps API errors without exposing a raw response', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ data: null, error: { code: 'NOT_READY', message: 'Not ready.' } }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    ));

    await expect(getJson('/ready', fetchImplementation)).rejects.toEqual(
      new ApiClientError(503, 'NOT_READY', 'Not ready.')
    );
  });

  it('maps an invalid non-JSON response to a safe client error', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('upstream failure', { status: 502, headers: { 'Content-Type': 'text/plain' } })
    );

    await expect(getJson('/ready', fetchImplementation)).rejects.toEqual(
      new ApiClientError(502, 'INVALID_RESPONSE', 'The local app returned an invalid response.')
    );
  });

  it('accepts a successful empty logout response and sends browser credentials', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(postNoContent('/api/v1/auth/logout', { 'X-CSRF-Token': 'csrf-value' }, fetchImplementation)).resolves.toBeUndefined();
    const [, requestInit] = fetchImplementation.mock.calls[0] ?? [];
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.credentials).toBe('include');
    expect(new Headers(requestInit?.headers).get('X-CSRF-Token')).toBe('csrf-value');
  });

  it('notifies the shared session boundary for a project-style 401 response', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ data: null, error: { code: 'SESSION_UNAUTHENTICATED', message: 'expired' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    ));
    const sessionExpired = vi.fn();
    const unregister = registerSessionExpiryHandler(sessionExpired);

    await expect(getJson('/api/v1/projects', fetchImplementation)).rejects.toEqual(
      new ApiClientError(401, 'SESSION_UNAUTHENTICATED', 'expired')
    );
    expect(sessionExpired).toHaveBeenCalledTimes(1);
    unregister();
  });
});
