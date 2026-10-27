import { createHash } from 'node:crypto';
import { findProject, readBody, sendData, sendError } from './preview-ai-run-support.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/^[\\/]|^[a-z]:|[\u0000-\u001f]/iu.test(value) &&
    !value.includes('\\') && value.split('/').every((part) => part && part !== '..' && part !== '.' && !part.startsWith('.') && !['node_modules', 'secrets'].includes(part));
}

export function previewFiles(seed, project) {
  if (project.relativeRoot === null) throw new Error('A project file root is required before reading preview files.');
  seed.files[project.relativeRoot] ??= { 'README.md': Buffer.from('# New project\n') };
  return seed.files[project.relativeRoot];
}

export function previewContext(seed, project) {
  const files = previewFiles(seed, project);
  seed.contexts[project.id] ??= { relativePaths: Object.keys(files).slice(0, 2), factIds: [], includeProjectConversations: true, excludedPaths: [] };
  return { ...seed.contexts[project.id], availablePaths: Object.keys(files), fileSelectionLimited: false };
}

export async function handlePreviewFiles(request, response, seed, parts, method, url) {
  if (!['files', 'chat-context', 'facts', 'provider-permissions', 'file-history'].includes(parts[4])) return false;
  const project = findProject(seed, parts[3]);
  if (!project) { sendError(response, 404, 'PROJECT_NOT_FOUND', 'Project not found.'); return true; }
  if (parts[4] === 'facts') { sendData(response, { facts: [] }); return true; }
  if (project.relativeRoot === null) { sendError(response, 409, 'PROJECT_ROOT_NOT_ATTACHED', 'Attach a project folder before using file access or assistant runs.'); return true; }
  if (parts[4] === 'provider-permissions') { sendData(response, { permissions: [] }); return true; }
  if (parts[4] === 'file-history') { sendData(response, { projectId: project.id, path: url.searchParams.get('path') ?? '', outcome: url.searchParams.get('outcome') ?? 'all', items: [], nextCursor: null }); return true; }
  if (parts[4] === 'chat-context') {
    if (method === 'PATCH') {
      const body = await readBody(request);
      const current = previewContext(seed, project);
      seed.contexts[project.id] = { ...current, ...body };
    }
    sendData(response, previewContext(seed, project)); return true;
  }
  const files = previewFiles(seed, project);
  if (parts[5] === 'tree' || !parts[5]) {
    sendData(response, { directory: '', depth: 4, entries: Object.entries(files).map(([path, bytes]) => ({ path, name: path.split('/').at(-1), type: 'file', sizeBytes: bytes.length })), truncated: false }); return true;
  }
  if (parts[5] === 'search') {
    const query = url.searchParams.get('query') ?? '';
    const matches = Object.entries(files).flatMap(([path, bytes]) => bytes.toString().split('\n').flatMap((text, index) => text.includes(query) ? [{ path, line: index + 1, column: Math.max(1, text.indexOf(query) + 1), text }] : []));
    sendData(response, { directory: '', query, matches: matches.slice(0, 50), filesScanned: Object.keys(files).length, truncated: matches.length > 50 }); return true;
  }
  const body = method === 'PUT' ? await readBody(request) : null;
  const filePath = body?.path ?? url.searchParams.get('path');
  if (!safePath(filePath)) { sendError(response, 400, 'WORKSPACE_PATH_INVALID', 'Choose a safe project-relative file.'); return true; }
  const bytes = files[filePath];
  if (method !== 'GET' && project.status !== 'active') { sendError(response, 409, 'PROJECT_ARCHIVED', 'Project is archived.'); return true; }
  if (method === 'POST' && parts[5] === 'upload') {
    if (bytes) { sendError(response, 409, 'FILE_CONFLICT', 'A file already exists.'); return true; }
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 8 * 1024 * 1024) { sendError(response, 413, 'FILE_TOO_LARGE', 'File exceeds 8 MB.'); return true; } chunks.push(chunk); }
    files[filePath] = Buffer.concat(chunks); project.updatedAt = new Date().toISOString();
    sendData(response, { hash: hash(files[filePath]) }, 201); return true;
  }
  if (!bytes) { sendError(response, 404, 'WORKSPACE_FILE_NOT_FOUND', 'File not found.'); return true; }
  if (method === 'GET' && parts[5] === 'download') {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', ETag: `"${hash(bytes)}"`, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filePath.split('/').at(-1))}` }); response.end(bytes); return true;
  }
  if (method === 'GET') {
    sendData(response, { path: filePath, content: bytes.toString('utf8'), sourceHash: hash(bytes), encoding: 'utf-8', lineCount: bytes.toString().split('\n').length, truncated: false, sizeBytes: bytes.length }); return true;
  }
  const expectedHash = method === 'PUT' ? body?.expectedHash : request.headers['if-match']?.replace(/^"|"$/gu, '');
  if (expectedHash !== hash(bytes)) { sendError(response, 409, 'FILE_CONFLICT', 'The file changed. Refresh before modifying it.'); return true; }
  if (method === 'PUT') {
    if (typeof body.content !== 'string' || Buffer.byteLength(body.content) > 512 * 1024) { sendError(response, 400, 'VALIDATION_ERROR', 'Use bounded text.'); return true; }
    files[filePath] = Buffer.from(body.content); sendData(response, { hash: hash(files[filePath]) });
  } else if (method === 'DELETE') { delete files[filePath]; response.writeHead(204); response.end(); }
  else { sendError(response, 404, 'PREVIEW_NOT_FOUND', 'Unknown file action.'); }
  project.updatedAt = new Date().toISOString();
  return true;
}
