import { randomUUID } from 'node:crypto';

import { buildTask } from './preview-tasks.mjs';
import { findProject, readBody, sendData, sendError, validIdempotencyKey } from './preview-ai-run-support.mjs';

const OWNER_ID = 'preview-owner';

export async function handlePreviewGlobalTasks(request, response, seed, idempotency, parts, method, url) {
  if (parts[2] !== 'tasks') return false;
  if (method === 'GET' && parts[3] === 'inbox' && parts[4] === 'count' && parts.length === 5) {
    sendData(response, { count: seed.tasks.filter((task) => task.projectId === null && task.status !== 'archived').length });
    return true;
  }
  if (method === 'GET' && parts.length === 3) {
    const filters = readFilters(url.searchParams);
    if (!filters) { sendError(response, 400, 'VALIDATION_ERROR', 'Choose valid task filters.'); return true; }
    if (filters.status === 'archived' && !filters.includeArchived) { sendError(response, 400, 'VALIDATION_ERROR', 'Include archived tasks to filter by archived status.'); return true; }
    const cursor = parseCursor(url.searchParams.get('cursor'), filters);
    if (url.searchParams.has('cursor') && !cursor) { sendError(response, 400, 'TASK_CURSOR_INVALID', 'Refresh the task list and try again.'); return true; }
    const matching = matchingTasks(seed, filters).sort(compareTasks);
    const afterIndex = cursor ? matching.findIndex((task) => task.id === cursor.id && task.createdAt === cursor.createdAt) : -1;
    if (cursor && afterIndex < 0) { sendError(response, 400, 'TASK_CURSOR_INVALID', 'Refresh the task list and try again.'); return true; }
    const start = afterIndex + 1;
    const page = matching.slice(start, start + filters.limit);
    const hasMore = start + page.length < matching.length;
    sendData(response, { items: page.map((task) => taskItem(seed, task)), nextCursor: hasMore ? makeCursor(page.at(-1), filters) : null });
    return true;
  }
  if (method === 'POST' && parts.length === 3) {
    await createInboxTask(request, response, seed, idempotency);
    return true;
  }
  if (method === 'GET' && parts.length === 4) {
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    const task = seed.tasks.find((candidate) => candidate.id === parts[3]);
    const workspace = task?.projectId ? findProject(seed, task.projectId) : null;
    if (!task || !includeArchived && (task.status === 'archived' || workspace?.status === 'archived')) {
      sendError(response, 404, 'TASK_NOT_FOUND', 'Task not found.');
      return true;
    }
    sendData(response, taskItem(seed, task));
    return true;
  }
  sendError(response, 404, 'PREVIEW_NOT_FOUND', 'This task route is not part of the mock preview.');
  return true;
}

async function createInboxTask(request, response, seed, idempotency) {
  const key = validIdempotencyKey(request);
  const body = await readBody(request);
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!key) { sendError(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'An idempotency key is required.'); return; }
  if (!title || Array.from(title).length > 120 || /[\u0000-\u001f\u007f]/u.test(title)) { sendError(response, 400, 'VALIDATION_ERROR', 'Enter a valid task title.'); return; }
  if (body.workspaceId !== null || body.importance !== 'medium' || body.deadline !== null || body.details !== null || !Array.isArray(body.subtasks) || body.subtasks.length !== 0) {
    sendError(response, 400, 'VALIDATION_ERROR', 'This capture endpoint accepts a default Inbox task only.');
    return;
  }
  const fingerprint = JSON.stringify({ title, workspaceId: null, importance: 'medium', deadline: null, details: null, subtasks: [] });
  const replayKey = `global-task:${OWNER_ID}:${key}`;
  const previous = idempotency.get(replayKey);
  if (previous) {
    if (previous.fingerprint !== fingerprint) { sendError(response, 409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different task.'); return; }
    sendData(response, { ...previous.result, replayed: true }, 200, { Location: `/api/v1/tasks/${previous.result.item.task.id}`, ETag: '"1"' });
    return;
  }
  const task = buildTask(null, { ...body, title }, seed.tasks.filter((candidate) => candidate.projectId === null).length);
  seed.tasks.push(task);
  const result = { item: taskItem(seed, task), receipt: { id: randomUUID(), actionKind: 'task.create', undoStatus: 'available', outcome: { targetId: task.id, targetVersion: task.version } }, replayed: false };
  idempotency.set(replayKey, { fingerprint, result });
  sendData(response, result, 201, { Location: `/api/v1/tasks/${task.id}`, ETag: `"${task.version}"` });
}

function readFilters(params) {
  const workspaceId = params.get('workspaceId');
  const inboxOnly = params.get('inboxOnly') === 'true';
  const status = params.get('status');
  const importance = params.get('importance');
  const deadlineFrom = params.get('deadlineFrom');
  const deadlineTo = params.get('deadlineTo');
  const q = params.get('q')?.trim() ?? '';
  const includeArchived = params.get('includeArchived') === 'true';
  const limit = Number(params.get('limit') ?? 25);
  if (workspaceId && inboxOnly || status && !['todo', 'in_progress', 'blocked', 'done', 'archived'].includes(status) ||
      importance && !['low', 'medium', 'high', 'urgent'].includes(importance) || q.length > 200 ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      deadlineFrom && !validDate(deadlineFrom) || deadlineTo && !validDate(deadlineTo) ||
      deadlineFrom && deadlineTo && deadlineFrom > deadlineTo) return null;
  return { workspaceId, inboxOnly, status, importance, deadlineFrom, deadlineTo, q, includeArchived, limit };
}

function matchingTasks(seed, filters) {
  return seed.tasks.filter((task) => {
    const workspace = task.projectId ? findProject(seed, task.projectId) : null;
    if (filters.workspaceId && task.projectId !== filters.workspaceId || filters.inboxOnly && task.projectId !== null) return false;
    if (!filters.includeArchived && (task.status === 'archived' || workspace?.status === 'archived')) return false;
    if (filters.status && task.status !== filters.status || filters.importance && task.importance !== filters.importance) return false;
    if (filters.deadlineFrom && (!task.deadline || task.deadline < filters.deadlineFrom) || filters.deadlineTo && (!task.deadline || task.deadline > filters.deadlineTo)) return false;
    if (filters.q && !`${task.title}\n${task.details ?? ''}`.toLocaleLowerCase().includes(filters.q.toLocaleLowerCase())) return false;
    return true;
  });
}

function taskItem(seed, task) {
  const workspace = task.projectId ? findProject(seed, task.projectId) : null;
  if (!workspace) return { task, collection: 'inbox', workspace: null };
  return { task, collection: 'workspace', workspace: { id: workspace.id, name: workspace.name, status: workspace.status } };
}

function compareTasks(left, right) {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function makeCursor(task, filters) {
  return Buffer.from(JSON.stringify({ version: 1, ownerId: OWNER_ID, filters, id: task.id, createdAt: task.createdAt })).toString('base64url');
}

function parseCursor(value, filters) {
  if (!value) return null;
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return cursor?.version === 1 && cursor.ownerId === OWNER_ID && JSON.stringify(cursor.filters) === JSON.stringify(filters) &&
      typeof cursor.id === 'string' && typeof cursor.createdAt === 'string' ? cursor : null;
  } catch { return null; }
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
