import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadWorkspaceExport } from '@/features/workspace-export/api/workspace-export-api';
import { advanceRequestSessionGeneration, ApiClientError, notifySessionExpiry, registerSessionExpiryHandler } from '@/shared/api';

afterEach(() => { vi.unstubAllGlobals(); });

describe('workspace export session boundary', () => {
  it.each([false, true])('notifies only an unauthorized response from the current session (stale=%s)', async (stale) => {
    let resolveResponse: (response: Response) => void = () => { throw new Error('Request not started'); };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>((resolve) => { resolveResponse = resolve; })));
    const expired = vi.fn();
    const unregister = registerSessionExpiryHandler(expired);
    const request = downloadWorkspaceExport('export-id');
    if (stale) advanceRequestSessionGeneration();
    resolveResponse(new Response(JSON.stringify({ data: null, error: { code: 'SESSION_UNAUTHENTICATED', message: 'Expired' } }), { status: 401 }));
    try {
      await request;
      throw new Error('The request should reject');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApiClientError);
      if (error instanceof ApiClientError) notifySessionExpiry(error.statusCode, error.code, error);
      expect(expired).toHaveBeenCalledTimes(stale ? 0 : 1);
    } finally { unregister(); }
  });
});
