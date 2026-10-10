import { randomUUID } from 'node:crypto';
import { findProject, readBody, sendData, sendError } from './preview-ai-run-support.mjs';
import { normalizePlanning, resolveChecklist, taskTitle } from './preview-task-planning.mjs';

export function taskSource(suggestion) {
  return suggestion ? { kind: 'assistant_suggestion', label: 'Added from an assistant suggestion · accepted by you', suggestionId: suggestion.id,
    runId: suggestion.runId, conversationId: suggestion.conversationId, acceptedAt: suggestion.resolvedAt }
    : { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null };
}

export function buildTask(projectId, body, position, suggestion) {
  const planning = normalizePlanning(body);
  const checklist = resolveChecklist({}, { ...body, subtasks: planning.subtasks }, planning);
  const timestamp = new Date().toISOString();
  return { id: randomUUID(), projectId, title: taskTitle(body.title), details: body.details?.trim() || null,
    ...planning, ...checklist, position, version: 1, source: taskSource(suggestion), createdAt: timestamp, updatedAt: timestamp,
    completedAt: checklist.status === 'done' ? timestamp : null, archivedAt: null };
}

export async function handlePreviewTasks(request, response, seed, idempotency, parts, method, url) {
  if (!['tasks', 'task-order', 'task-suggestions'].includes(parts[4])) return false;
  const project = findProject(seed, parts[3]);
  if (!project) { sendError(response, 404, 'PROJECT_NOT_FOUND', 'Project not found.'); return true; }
  if (method !== 'GET' && project.status === 'archived') { sendError(response, 409, 'PROJECT_TASK_PROJECT_ARCHIVED', 'Project is archived.'); return true; }
  const tasks = seed.tasks.filter((task) => task.projectId === project.id);
  const orderVersion = seed.taskOrders[project.id] ?? 1;
  try {
    if (parts[4] === 'task-suggestions') await suggestions(request, response, seed, project, parts, method, url);
    else if (parts[4] === 'task-order') await reorder(request, response, seed, project, tasks, orderVersion);
    else if (method === 'GET' && !parts[5]) {
      const filter = url.searchParams.get('status') ?? 'all';
      const visible = tasks.filter((task) => filter === 'all' || (filter === 'open' ? !['done', 'archived'].includes(task.status) : filter === 'completed' ? task.status === 'done' : task.status === 'archived'));
      sendData(response, { tasks: visible.sort((a, b) => a.position - b.position), orderVersion });
    } else if (method === 'POST' && !parts[5]) await createTask(request, response, seed, idempotency, project, tasks);
    else await mutateTask(request, response, seed, project, tasks, parts[5], method);
  } catch (error) { sendError(response, 400, 'PROJECT_TASK_VALIDATION_ERROR', error.message); }
  return true;
}

async function createTask(request, response, seed, idempotency, project, tasks) {
  const body = await readBody(request);
  const key = request.headers['idempotency-key'];
  if (!key) { sendError(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'An idempotency key is required.'); return; }
  const replayKey = `task:${project.id}:${key}`;
  const previous = idempotency.get(replayKey);
  if (previous) {
    if (previous.fingerprint !== JSON.stringify(body)) sendError(response, 409, 'PROJECT_TASK_IDEMPOTENCY_REUSED', 'Request key reused.');
    else sendData(response, previous.result, 201);
    return;
  }
  const task = buildTask(project.id, body, tasks.length);
  seed.tasks.push(task);
  const result = { task, orderVersion: bumpOrder(seed, project.id) };
  idempotency.set(replayKey, { fingerprint: JSON.stringify(body), result });
  project.updatedAt = task.updatedAt;
  sendData(response, result, 201);
}

function versionAllowed(request, response, version, code = 'PROJECT_TASK_VERSION_CONFLICT') {
  const raw = request.headers['if-match'];
  if (!/^"[1-9]\d*"$/u.test(raw ?? '')) { sendError(response, 428, 'PROJECT_TASK_VERSION_REQUIRED', 'A quoted current version is required.'); return false; }
  if (Number(raw.slice(1, -1)) !== version) { sendError(response, 409, code, 'Refresh before changing this item.'); return false; }
  return true;
}

async function mutateTask(request, response, seed, project, tasks, taskId, method) {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) { sendError(response, 404, 'PROJECT_TASK_NOT_FOUND', 'Task not found.'); return; }
  if (!versionAllowed(request, response, task.version)) return;
  if (method === 'DELETE') {
    seed.tasks = seed.tasks.filter((item) => item.id !== task.id);
    tasks.filter((item) => item.id !== task.id).sort((a, b) => a.position - b.position).forEach((item, position) => { item.position = position; });
    for (const suggestion of seed.taskSuggestions) if (suggestion.taskId === task.id) suggestion.taskId = null;
    project.updatedAt = new Date().toISOString();
    sendData(response, { orderVersion: bumpOrder(seed, project.id) }); return;
  }
  const body = await readBody(request);
  if (body.status !== undefined) {
    const transitions = { todo: ['in_progress', 'done'], in_progress: ['blocked', 'done'], blocked: ['in_progress', 'done'], done: ['todo'], archived: [] };
    if (!transitions[task.status].includes(body.status)) { sendError(response, 409, 'PROJECT_TASK_STATUS_CONFLICT', 'Status transition is unavailable.'); return; }
  }
  const planning = normalizePlanning(body, task);
  const checklist = resolveChecklist(task, body, planning);
  Object.assign(task, planning, checklist, body.title === undefined ? {} : { title: taskTitle(body.title) }, body.details === undefined ? {} : { details: body.details?.trim() || null });
  task.version += 1; task.updatedAt = new Date().toISOString(); task.completedAt = task.status === 'done' ? task.updatedAt : null;
  project.updatedAt = task.updatedAt;
  sendData(response, { task, orderVersion: seed.taskOrders[project.id] ?? 1 });
}

async function reorder(request, response, seed, project, tasks, orderVersion) {
  if (!versionAllowed(request, response, orderVersion, 'PROJECT_TASK_ORDER_CONFLICT')) return;
  const body = await readBody(request);
  const ordered = tasks.sort((a, b) => a.position - b.position);
  const index = ordered.findIndex((task) => task.id === body?.taskId);
  const adjacent = index + (body?.direction === 'up' ? -1 : 1);
  if (index < 0 || adjacent < 0 || adjacent >= ordered.length) { sendError(response, 409, 'PROJECT_TASK_ORDER_BOUNDARY', 'Task cannot move further.'); return; }
  [ordered[index], ordered[adjacent]] = [ordered[adjacent], ordered[index]];
  ordered.forEach((task, position) => { task.position = position; });
  sendData(response, { tasks: ordered, orderVersion: bumpOrder(seed, project.id) });
}

async function suggestions(request, response, seed, project, parts, method, url) {
  const scoped = seed.taskSuggestions.filter((item) => item.projectId === project.id);
  if (method === 'GET') {
    const conversationId = url.searchParams.get('conversationId');
    const status = url.searchParams.get('status') ?? 'pending';
    sendData(response, { taskSuggestions: scoped.filter((item) => (!conversationId || item.conversationId === conversationId) && (status === 'all' || item.status === status)) }); return;
  }
  const suggestion = scoped.find((item) => item.id === parts[5]);
  if (!suggestion) { sendError(response, 404, 'PROJECT_TASK_SUGGESTION_NOT_FOUND', 'Suggestion not found.'); return; }
  if (!versionAllowed(request, response, suggestion.version)) return;
  if (suggestion.status !== 'pending') { sendError(response, 409, 'PROJECT_TASK_SUGGESTION_RESOLVED', 'Suggestion already resolved.'); return; }
  const body = await readBody(request);
  if (!['accepted', 'dismissed'].includes(body?.status)) throw new Error('Choose accept or dismiss.');
  const resolvedAt = new Date().toISOString();
  const task = body.status === 'accepted' ? buildTask(project.id, { ...suggestion, ...body, status: undefined }, seed.tasks.filter((item) => item.projectId === project.id).length,
    { ...suggestion, resolvedAt }) : null;
  suggestion.status = body.status; suggestion.version += 1; suggestion.resolvedAt = resolvedAt; suggestion.taskId = task?.id ?? null;
  if (task) { seed.tasks.push(task); sendData(response, { task, taskSuggestion: suggestion, orderVersion: bumpOrder(seed, project.id) }); }
  else sendData(response, { taskSuggestion: suggestion });
}

function bumpOrder(seed, projectId) {
  seed.taskOrders[projectId] = (seed.taskOrders[projectId] ?? 1) + 1;
  return seed.taskOrders[projectId];
}
