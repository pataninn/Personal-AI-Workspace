import { describe, expect, it, vi } from 'vitest';

import { ApiClientError, deleteNoContent, getJson, postNoContent } from '@/shared/api/api-client';
import { advanceRequestSessionGeneration, notifySessionExpiry, registerSessionExpiryHandler } from '@/shared/api/session-expiry';

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

  it('preserves structured response data for callers that need a safe conflict reason', async () => {
    const conflictData = { reason: 'workspace_not_empty', originalAction: { id: 'action-id' }, target: null };
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ data: conflictData, error: { code: 'ACTION_UNDO_CONFLICT', message: 'The target changed.' } }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    ));

    await expect(getJson('/actions/action-id', fetchImplementation)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ACTION_UNDO_CONFLICT',
      responseData: conflictData
    });
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

  it('accepts a successful empty delete response and preserves version headers', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(deleteNoContent('/api/v1/projects/one/facts/two', { 'If-Match': '3' }, fetchImplementation)).resolves.toBeUndefined();
    const [, requestInit] = fetchImplementation.mock.calls[0] ?? [];
    expect(requestInit?.method).toBe('DELETE');
    expect(requestInit?.credentials).toBe('include');
    expect(new Headers(requestInit?.headers).get('If-Match')).toBe('3');
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

  it.each(['json', 'no-content', 'invalid-json'] as const)('suppresses stale %s errors including manual repeated notifications', async (kind) => {
    let resolveOld: (response: Response) => void = () => { throw new Error('Request not started'); };
    const fetchImplementation = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>((resolve) => { resolveOld = resolve; }));
    const sessionExpired = vi.fn();
    const unregister = registerSessionExpiryHandler(sessionExpired);
    const pending = kind === 'no-content' ? postNoContent('/old', undefined, fetchImplementation) : getJson('/old', fetchImplementation);
    advanceRequestSessionGeneration();
    resolveOld(kind === 'invalid-json' ? new Response('not JSON', { status: 401 })
      : new Response(JSON.stringify({ data: null, error: { code: 'SESSION_UNAUTHENTICATED', message: 'Old request' } }), { status: 401 }));
    try {
      await pending;
      throw new Error('The request should reject');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApiClientError);
      if (error instanceof ApiClientError) notifySessionExpiry(error.statusCode, error.code, error);
      expect(sessionExpired).not.toHaveBeenCalled();
    } finally { unregister(); }
  });
});
