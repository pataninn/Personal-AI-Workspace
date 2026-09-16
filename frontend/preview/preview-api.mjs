import { randomUUID } from 'node:crypto';

import { createPreviewAiRuns } from './preview-ai-runs.mjs';
import { createPreviewSeed } from './preview-seed.mjs';

const COOKIE_NAME = 'pai_preview_session';
const CSRF_TOKEN = 'preview-only-csrf-token';
const PRINCIPAL = { id: '5eb82c22-8424-4b9f-87f4-ea20dfbfc16d', displayName: 'Preview user' };

function sendData(response, data, status = 200, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify({ data, error: null }));
}

function sendError(response, status, code, message) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ data: null, error: { code, message } }));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64_000) {
      return null;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function isSignedIn(request) {
  return request.headers.cookie?.split(';').some((cookie) => cookie.trim() === `${COOKIE_NAME}=1`) ?? false;
}

function isMutationAllowed(request) {
  return request.headers['x-csrf-token'] === CSRF_TOKEN;
}

function now() {
  return new Date().toISOString();
}

function findProject(seed, projectId) {
  return seed.projects.find((project) => project.id === projectId);
}

function findConversation(seed, conversationId, projectId) {
  return seed.conversations.find((conversation) => conversation.id === conversationId && conversation.projectId === projectId);
}

function isOverlappingRoot(seed, root, excludingId) {
  const key = root.toLowerCase();
  return seed.projects.some((project) => project.status === 'active' && project.id !== excludingId && (
    project.relativeRoot.toLowerCase() === key ||
    project.relativeRoot.toLowerCase().startsWith(`${key}/`) ||
    key.startsWith(`${project.relativeRoot.toLowerCase()}/`)
  ));
}

function isValidRoot(root) {
  return root.length > 0 && !root.startsWith('/') && !root.startsWith('\\') &&
    !/^[a-z]:/iu.test(root) && !root.includes(':') &&
    root.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function previewSession() {
  return { principal: PRINCIPAL, csrfToken: CSRF_TOKEN, expiresAt: '2099-01-01T00:00:00.000Z' };
}

export function createPreviewApi() {
  let seed = createPreviewSeed();
  let idempotency = new Map();
  const aiRuns = createPreviewAiRuns();

  function reset() {
    seed = createPreviewSeed();
    idempotency = new Map();
    aiRuns.reset();
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = request.method ?? 'GET';
    if (url.pathname === '/api/v1/auth/login' && method === 'POST') {
      const body = await readBody(request);
      if (typeof body?.password !== 'string' || body.password.trim().length === 0) {
        sendError(response, 400, 'VALIDATION_ERROR', 'Enter any non-empty password for the mock preview.');
        return;
      }
      sendData(response, previewSession(), 200, { 'Set-Cookie': `${COOKIE_NAME}=1; HttpOnly; SameSite=Lax; Path=/` });
      return;
    }
    if (!isSignedIn(request)) {
      sendError(response, 401, 'SESSION_UNAUTHENTICATED', 'Sign in to the mock preview.');
      return;
    }
    if (url.pathname === '/api/v1/auth/session' && method === 'GET') {
      sendData(response, previewSession());
      return;
    }
    if (url.pathname === '/api/v1/auth/logout' && method === 'POST') {
      response.writeHead(204, { 'Set-Cookie': `${COOKIE_NAME}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/` });
      response.end();
      return;
    }
    if (['POST', 'PATCH'].includes(method) && !isMutationAllowed(request)) {
      sendError(response, 403, 'CSRF_INVALID', 'The mock preview request is missing its CSRF token.');
      return;
    }
    if (await aiRuns.handle(request, response, seed, parts, method)) {
      return;
    }
    if (parts[2] === 'projects') {
      await handleProjects(request, response, seed, idempotency, parts, method);
      return;
    }
    if (parts[2] === 'conversations') {
      await handleConversations(request, response, seed, idempotency, parts, method, url);
      return;
    }
    sendError(response, 404, 'PREVIEW_NOT_FOUND', 'This API route is not part of the mock preview.');
  }

  return { handle, reset };
}

async function handleProjects(request, response, seed, idempotency, parts, method) {
  const projectId = parts[3];
  if (!projectId && method === 'GET') {
    sendData(response, { projects: seed.projects });
    return;
  }
  if (!projectId && method === 'POST') {
    const body = await readBody(request);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const relativeRoot = typeof body?.relativeRoot === 'string' ? body.relativeRoot.trim().replaceAll('\\', '/') : '';
    if (!name || !isValidRoot(relativeRoot)) {
      sendError(response, 400, 'VALIDATION_ERROR', 'Enter a project name and relative root.');
      return;
    }
    if (isOverlappingRoot(seed, relativeRoot)) {
      sendError(response, 409, 'PROJECT_ROOT_OVERLAP', 'Choose a non-overlapping preview root.');
      return;
    }
    const createdAt = now();
    const project = { id: randomUUID(), name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), relativeRoot, status: 'active', version: 1, createdAt, updatedAt: createdAt };
    seed.projects.push(project);
    sendData(response, project, 201);
    return;
  }
  const project = findProject(seed, projectId);
  if (!project) {
    sendError(response, 404, 'PROJECT_NOT_FOUND', 'Project not found in the mock preview.');
    return;
  }
  if (!parts[4] && method === 'GET') {
    sendData(response, project);
    return;
  }
  if (!parts[4] && method === 'PATCH') {
    const body = await readBody(request);
    if (!['active', 'archived'].includes(body?.status)) {
      sendError(response, 400, 'VALIDATION_ERROR', 'Choose active or archived.');
      return;
    }
    if (Number(request.headers['if-match']) !== project.version) {
      sendError(response, 409, 'PROJECT_VERSION_CONFLICT', 'Refresh the mock project and try again.');
      return;
    }
    if (body.status === 'active' && isOverlappingRoot(seed, project.relativeRoot, project.id)) {
      sendError(response, 409, 'PROJECT_ROOT_OVERLAP', 'Choose a non-overlapping preview root.');
      return;
    }
    project.status = body.status;
    project.version += 1;
    project.updatedAt = now();
    sendData(response, project);
    return;
  }
  if (parts[4] === 'conversations') {
    await handleProjectConversations(request, response, seed, idempotency, parts, method);
    return;
  }
  sendError(response, 404, 'PREVIEW_NOT_FOUND', 'This project route is not part of the mock preview.');
}

async function handleProjectConversations(request, response, seed, idempotency, parts, method) {
  const project = findProject(seed, parts[3]);
  if (!project) {
    sendError(response, 404, 'PROJECT_NOT_FOUND', 'Project not found in the mock preview.');
    return;
  }
  if (method === 'GET') {
    sendData(response, { conversations: seed.conversations.filter((item) => item.projectId === project.id).sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt)), nextCursor: null });
    return;
  }
  if (method === 'POST') {
    if (project.status === 'archived') {
      sendError(response, 409, 'PROJECT_ARCHIVED', 'This preview project is archived.');
      return;
    }
    const body = await readBody(request);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) {
      sendError(response, 400, 'VALIDATION_ERROR', 'Enter a conversation name.');
      return;
    }
    const key = request.headers['idempotency-key'];
    const replayKey = key ? `conversation:${project.id}:${key}` : null;
    const previous = replayKey ? idempotency.get(replayKey) : undefined;
    if (previous) {
      if (previous.title !== title) {
        sendError(response, 409, 'IDEMPOTENCY_KEY_REUSED', 'This preview request key was already used.');
      } else {
        sendData(response, previous.conversation, 200);
      }
      return;
    }
    const createdAt = now();
    const conversation = { id: randomUUID(), projectId: project.id, title, status: 'active', lastActivityAt: createdAt, createdAt, updatedAt: createdAt };
    seed.conversations.push(conversation);
    if (replayKey) {
      idempotency.set(replayKey, { title, conversation });
    }
    sendData(response, conversation, 201);
    return;
  }
  sendError(response, 404, 'PREVIEW_NOT_FOUND', 'This conversation route is not part of the mock preview.');
}

async function handleConversations(request, response, seed, idempotency, parts, method, url) {
  const conversationId = parts[3];
  const projectId = url.searchParams.get('projectId');
  const conversation = findConversation(seed, conversationId, projectId);
  if (!conversation) {
    sendError(response, 404, 'CONVERSATION_NOT_FOUND', 'Conversation not found in this preview project.');
    return;
  }
  if (!parts[4] && method === 'GET') {
    const beforeSequence = Number(url.searchParams.get('beforeSequence') ?? Infinity);
    const all = seed.messages.filter((message) => message.conversationId === conversationId && message.sequence < beforeSequence).sort((left, right) => left.sequence - right.sequence);
    const messages = all.slice(-200);
    sendData(response, { conversation, messages, nextBeforeSequence: all.length > messages.length ? messages[0].sequence : null });
    return;
  }
  if (parts[4] === 'messages' && method === 'POST') {
    const project = findProject(seed, projectId);
    if (project?.status === 'archived') {
      sendError(response, 409, 'PROJECT_ARCHIVED', 'This preview project is archived.');
      return;
    }
    const body = await readBody(request);
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!content) {
      sendError(response, 400, 'VALIDATION_ERROR', 'Enter a message.');
      return;
    }
    const key = request.headers['idempotency-key'];
    const replayKey = key ? `message:${key}` : null;
    const previous = replayKey ? idempotency.get(replayKey) : undefined;
    if (previous) {
      if (previous.conversationId !== conversationId || previous.content !== body.content) {
        sendError(response, 409, 'IDEMPOTENCY_KEY_REUSED', 'This preview request key was already used.');
        return;
      }
      sendData(response, previous.message, 200);
      return;
    }
    const createdAt = now();
    const sequence = seed.messages.filter((message) => message.conversationId === conversationId).length + 1;
    const message = { id: randomUUID(), conversationId, role: 'user', sequence, content: body.content, createdAt };
    seed.messages.push(message);
    conversation.lastActivityAt = createdAt;
    conversation.updatedAt = createdAt;
    if (replayKey) {
      idempotency.set(replayKey, { conversationId, content: body.content, message });
    }
    sendData(response, message, 201);
    return;
  }
  sendError(response, 404, 'PREVIEW_NOT_FOUND', 'This conversation route is not part of the mock preview.');
}
