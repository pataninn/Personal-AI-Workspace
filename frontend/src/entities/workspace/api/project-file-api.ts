import { getJson, getRequestSessionGeneration, notifySessionExpiry, requestJson, deleteNoContent, ApiClientError } from '@/shared/api';

export interface ProjectTextFile {
  readonly path: string;
  readonly content: string;
  readonly sourceHash: string;
  readonly truncated: boolean;
  readonly sizeBytes: number;
}

function fileUrl(projectId: string, action: string, path?: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/files/${action}${path ? `?${new URLSearchParams({ path })}` : ''}`;
}

export function readProjectFile(projectId: string, path: string): Promise<ProjectTextFile> {
  return getJson<ProjectTextFile>(fileUrl(projectId, 'content', path));
}

export function saveProjectFile(projectId: string, file: ProjectTextFile, content: string, csrfToken: string): Promise<{ hash: string }> {
  return requestJson(fileUrl(projectId, 'content'), { method: 'PUT', body: { path: file.path, content, expectedHash: file.sourceHash }, headers: { 'X-CSRF-Token': csrfToken } });
}

export function deleteProjectFile(projectId: string, path: string, hash: string, csrfToken: string): Promise<void> {
  return deleteNoContent(fileUrl(projectId, 'content', path), { 'X-CSRF-Token': csrfToken, 'If-Match': `"${hash}"` });
}

export async function downloadProjectFile(projectId: string, path: string): Promise<{ blob: Blob; hash: string }> {
  const generation = getRequestSessionGeneration();
  const response = await fetch(fileUrl(projectId, 'download', path), { credentials: 'include' });
  if (!response.ok) await fileError(response, generation);
  const hash = response.headers.get('ETag')?.replace(/^"|"$/gu, '') ?? '';
  return { blob: await response.blob(), hash };
}

export async function uploadProjectFile(projectId: string, file: File, csrfToken: string): Promise<{ readonly path: string; readonly converted: boolean }> {
  const generation = getRequestSessionGeneration();
  const response = await fetch(fileUrl(projectId, 'upload', file.name), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrfToken }, body: file });
  if (!response.ok) await fileError(response, generation);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('data' in body) || !body.data || typeof body.data !== 'object' || !('path' in body.data) || typeof body.data.path !== 'string' || !('converted' in body.data) || typeof body.data.converted !== 'boolean') {
    throw new ApiClientError(response.status, 'INVALID_FILE_RESPONSE', 'The uploaded file could not be confirmed. Refresh the file list.');
  }
  return { path: body.data.path, converted: body.data.converted };
}

async function fileError(response: Response, generation: number): Promise<never> {
  const body: unknown = await response.json().catch(() => null);
  let message = 'The file operation failed.';
  let code = 'FILE_REQUEST_FAILED';
  if (body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object') {
    if ('message' in body.error && typeof body.error.message === 'string') message = body.error.message;
    if ('code' in body.error && typeof body.error.code === 'string') code = body.error.code;
  }
  const error = new ApiClientError(response.status, code, message);
  notifySessionExpiry(response.status, code, error, generation);
  throw error;
}
