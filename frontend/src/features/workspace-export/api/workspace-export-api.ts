import { ApiClientError, getRequestSessionGeneration, notifySessionExpiry, postJson } from '@/shared/api';

export interface WorkspaceExportDescriptor {
  readonly id: string;
  readonly workspaceId: string;
  readonly sizeBytes: number;
  readonly expiresAt: string;
}

export async function createWorkspaceExport(
  workspaceId: string,
  csrfToken: string,
  idempotencyKey: string
): Promise<WorkspaceExportDescriptor> {
  const result = await postJson<{ readonly export: WorkspaceExportDescriptor }>(
    '/api/v1/workspace-exports',
    { workspaceId },
    { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }
  );
  return result.export;
}

export async function downloadWorkspaceExport(exportId: string): Promise<Blob> {
  const generation = getRequestSessionGeneration();
  const response = await fetch(`/api/v1/workspace-exports/${encodeURIComponent(exportId)}`, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json, application/octet-stream' }
  });
  if (!response.ok) {
    let code = 'HTTP_ERROR';
    let message = 'The workspace export is unavailable.';
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && isRecord(body.error)) {
        if (typeof body.error.code === 'string') code = body.error.code;
        if (typeof body.error.message === 'string') message = body.error.message;
      }
    } catch { /* Keep the same generic unavailable message for malformed error responses. */ }
    const error = new ApiClientError(response.status, code, message);
    notifySessionExpiry(error.statusCode, error.code, error, generation);
    throw error;
  }
  const blob = await response.blob();
  if (blob.size === 0 || blob.type && !blob.type.toLowerCase().startsWith('application/json')) {
    throw new ApiClientError(response.status, 'INVALID_RESPONSE', 'The workspace export could not be downloaded.');
  }
  return blob;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
