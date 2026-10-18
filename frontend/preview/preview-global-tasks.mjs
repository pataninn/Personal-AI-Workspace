import { randomUUID } from 'node:crypto';

import { buildTask } from './preview-tasks.mjs';
import { normalizePlanning, resolveChecklist, taskTitle } from './preview-task-planning.mjs';
import { findProject, readBody, sendData, sendError, validIdempotencyKey } from './preview-ai-run-support.mjs';

const OWNER_ID = '5eb82c22-8424-4b9f-87f4-ea20dfbfc16d';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATUSES = new Set(['todo', 'in_progress', 'blocked', 'done']);
const TRANSITIONS = { todo: new Set(['in_progress', 'done']), in_progress: new Set(['blocked', 'done']), blocked: new Set(['in_progress', 'done']), done: new Set(['todo']), archived: new Set() };
const UPDATE_FIELDS = new Set(['title', 'details', 'status', 'importance', 'deadline', 'subtasks']);

export async function handlePreviewGlobalTasks(request, response, seed, idempotency, actionRecords, parts, method, url) {
  if (parts[2] === 'actions') {
    await handleActionRoute(request, response, seed, idempotency, actionRecords, parts, method);
    return true;
  }
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
    await createGlobalTask(request, response, seed, idempotency);
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
  if (method === 'PATCH' && parts.length === 4) {
    await updateTask(request, response, seed, idempotency, actionRecords, parts[3]);
    return true;
  }
  if (method === 'POST' && parts.length === 5 && parts[4] === 'move') {
    await moveTask(request, response, seed, idempotency, actionRecords, parts[3]);
    return true;
  }
  if (method === 'POST' && parts.length === 5 && parts[4] === 'archive') {
    await archiveTask(request, response, seed, idempotency, actionRecords, parts[3]);
    return true;
  }
  sendError(response, 404, 'PREVIEW_NOT_FOUND', 'This task route is not part of the mock preview.');
  return true;
}

async function updateTask(request, response, seed, idempotency, actionRecords, taskId) {
  const body = await readBody(request);
  if (!isRecord(body) || Object.keys(body).some((field) => !UPDATE_FIELDS.has(field)) || Object.keys(body).length === 0) {
    sendError(response, 400, 'VALIDATION_ERROR', 'Provide valid task fields to update.'); return;
  }
  if (body.status !== undefined && Object.keys(body).length > 1) {
    sendError(response, 409, 'PROJECT_TASK_STATUS_CONFLICT', 'Send a status transition separately from field edits.'); return;
  }
  const expectedVersion = readIfMatch(request, response);
  if (expectedVersion === null) return;
  const key = readMutationKey(request, response);
  if (!key) return;
  const fingerprint = stableJson({ actionKind: 'task.update', taskId, expectedVersion, body });
  const replay = findReplay(idempotency, actionRecords, key, fingerprint, response);
  if (replay) {
    if (replay.handled) return;
    const task = seed.tasks.find((candidate) => candidate.id === replay.record.targetId);
    if (!task) { sendError(response, 404, 'PROJECT_TASK_NOT_FOUND', 'Task not found.'); return; }
    sendMutation(response, seed, task, replay.record, true);
    return;
  }
  const task = seed.tasks.find((candidate) => candidate.id === taskId);
  if (!task) { sendError(response, 404, 'PROJECT_TASK_NOT_FOUND', 'Task not found.'); return; }
  if (!canMutateTask(seed, task, response)) return;
  if (task.version !== expectedVersion) { sendError(response, 409, 'PROJECT_TASK_VERSION_CONFLICT', 'This task changed. Reload the latest version and try again.'); return; }

  let patch;
  try { patch = normalizeUpdate(body, task); }
  catch (error) { sendError(response, 400, 'VALIDATION_ERROR', error.message); return; }
  if (patch.status !== undefined && !TRANSITIONS[task.status]?.has(patch.status)) {
    sendError(response, 409, 'PROJECT_TASK_STATUS_CONFLICT', 'This task cannot move to that status.'); return;
  }
  const before = snapshotTask(task);
  applyUpdate(task, patch);
  task.version += 1;
  task.updatedAt = new Date().toISOString();
  const fields = reversibleDiff(before, task);
  const record = makeRecord({
    actionKind: 'task.update', task, expectedVersion, preVersion: before.version, reversibleFields: fields,
    outcome: { targetId: task.id, targetVersion: task.version, sourceOrderVersion: orderVersion(seed, task.projectId) },
    undoStatus: Object.keys(fields).length === 0 ? 'not_reversible' : 'available'
  });
  actionRecords.set(record.id, record);
  idempotency.set(mutationSlot(key), { fingerprint, actionId: record.id });
  sendMutation(response, seed, task, record, false);
}

async function moveTask(request, response, seed, idempotency, actionRecords, taskId) {
  const body = await readBody(request);
  if (!isRecord(body) || Object.keys(body).some((field) => !['workspaceId', 'expectedSourceOrderVersion', 'expectedDestinationOrderVersion'].includes(field)) ||
      !Object.hasOwn(body, 'workspaceId') || body.workspaceId !== null && (typeof body.workspaceId !== 'string' || !UUID.test(body.workspaceId)) ||
      !validOptionalVersion(body.expectedSourceOrderVersion) || !validOptionalVersion(body.expectedDestinationOrderVersion)) {
    sendError(response, 400, 'VALIDATION_ERROR', 'Choose a valid destination workspace.'); return;
  }
  const expectedVersion = readIfMatch(request, response);
  if (expectedVersion === null) return;
  const key = readMutationKey(request, response);
  if (!key) return;
  const fingerprint = stableJson({ actionKind: 'task.move', taskId, expectedVersion, body });
  const replay = findReplay(idempotency, actionRecords, key, fingerprint, response);
  if (replay) {
    if (replay.handled) return;
    const task = seed.tasks.find((candidate) => candidate.id === replay.record.targetId);
    if (!task) { sendError(response, 404, 'PROJECT_TASK_NOT_FOUND', 'Task not found.'); return; }
    sendMutation(response, seed, task, replay.record, true);
    return;
  }
  const task = seed.tasks.find((candidate) => candidate.id === taskId);
  if (!task) { sendError(response, 404, 'PROJECT_TASK_NOT_FOUND', 'Task not found.'); return; }
  if (!canMutateTask(seed, task, response)) return;
  if (task.version !== expectedVersion) { sendError(response, 409, 'PROJECT_TASK_VERSION_CONFLICT', 'This task changed. Reload the latest version and try again.'); return; }
  const destination = body.workspaceId;
  const project = destination === null ? null : findProject(seed, destination);
  if (destination !== null && !project) { sendError(response, 404, 'PROJECT_TASK_NOT_FOUND', 'Task not found.'); return; }
  if (project?.status === 'archived') { sendError(response, 409, 'PROJECT_ARCHIVED', 'This workspace is archived.'); return; }
  if (task.projectId === destination) { sendError(response, 409, 'PROJECT_TASK_MOVE_CONFLICT', 'This task is already in that collection.'); return; }
  const sourceOrderVersion = orderVersion(seed, task.projectId);
  const destinationOrderVersion = orderVersion(seed, destination);
  if (body.expectedSourceOrderVersion !== undefined && body.expectedSourceOrderVersion !== sourceOrderVersion ||
      body.expectedDestinationOrderVersion !== undefined && body.expectedDestinationOrderVersion !== destinationOrderVersion) {
    sendError(response, 409, 'PROJECT_TASK_ORDER_CONFLICT', 'The task order changed. Reload the latest order and try again.'); return;
  }
  const before = snapshotTask(task);
  const destinationPosition = activeTasks(seed, destination).length;
  task.projectId = destination;
  task.position = destinationPosition;
  task.version += 1;
  task.updatedAt = new Date().toISOString();
  compactPositions(seed, before.projectId);
  const postSourceOrderVersion = bumpOrder(seed, before.projectId);
  const postDestinationOrderVersion = bumpOrder(seed, destination);
  const fields = { projectId: { before: before.projectId, after: task.projectId }, position: { before: before.position, after: task.position } };
  const record = makeRecord({
    actionKind: 'task.move', task, expectedVersion, preVersion: before.version, reversibleFields: fields,
    outcome: { targetId: task.id, targetVersion: task.version, sourceOrderVersion: postSourceOrderVersion, destinationOrderVersion: postDestinationOrderVersion },
    undoStatus: 'available'
  });
  actionRecords.set(record.id, record);
  idempotency.set(mutationSlot(key), { fingerprint, actionId: record.id });
  sendMutation(response, seed, task, record, false);
}

async function archiveTask(request, response, seed, idempotency, actionRecords, taskId) {
  const body = await readBody(request);
  if (!isRecord(body) || Object.keys(body).some((field) => field !== 'expectedOrderVersion') || !validOptionalVersion(body.expectedOrderVersion)) {
    sendError(response, 400, 'VALIDATION_ERROR', 'The archive request is invalid.'); return;
  }
  const expectedVersion = readIfMatch(request, response);
  if (expectedVersion === null) return;
  const key = readMutationKey(request, response);
  if (!key) return;
  const fingerprint = stableJson({ actionKind: 'task.archive', taskId, expectedVersion, body });
  const replay = findReplay(idempotency, actionRecords, key, fingerprint, response);
  if (replay) {
    if (replay.handled) return;
    const task = seed.tasks.find((candidate) => candidate.id === replay.record.targetId);
    if (!task) { sendError(response, 404, 'PROJECT_TASK_NOT_FOUND', 'Task not found.'); return; }
    sendMutation(response, seed, task, replay.record, true);
    return;
  }
  const task = seed.tasks.find((candidate) => candidate.id === taskId);
  if (!task) { sendError(response, 404, 'PROJECT_TASK_NOT_FOUND', 'Task not found.'); return; }
  if (!canMutateTask(seed, task, response)) return;
  if (task.version !== expectedVersion) { sendError(response, 409, 'PROJECT_TASK_VERSION_CONFLICT', 'This task changed. Reload the latest version and try again.'); return; }
  const currentOrderVersion = orderVersion(seed, task.projectId);
  if (body.expectedOrderVersion !== undefined && body.expectedOrderVersion !== currentOrderVersion) {
    sendError(response, 409, 'PROJECT_TASK_ORDER_CONFLICT', 'The task order changed. Reload the latest order and try again.'); return;
  }
  const before = snapshotTask(task);
  task.status = 'archived';
  task.archivedAt = new Date().toISOString();
  task.version += 1;
  task.updatedAt = task.archivedAt;
  compactPositions(seed, task.projectId);
  const postOrderVersion = bumpOrder(seed, task.projectId);
  const fields = { status: { before: before.status, after: 'archived' }, archivedAt: { before: before.archivedAt, after: task.archivedAt } };
  const record = makeRecord({
    actionKind: 'task.archive', task, expectedVersion, preVersion: before.version, reversibleFields: fields,
    outcome: { targetId: task.id, targetVersion: task.version, sourceOrderVersion: postOrderVersion }, undoStatus: 'available'
  });
  actionRecords.set(record.id, record);
  idempotency.set(mutationSlot(key), { fingerprint, actionId: record.id });
  sendMutation(response, seed, task, record, false);
}

async function handleActionRoute(request, response, seed, idempotency, actionRecords, parts, method) {
  const actionId = parts[3];
  if (!actionId || !UUID.test(actionId)) { sendError(response, 400, 'VALIDATION_ERROR', 'Use an action UUID.'); return; }
  if (method === 'GET' && parts.length === 4) {
    const record = actionRecords.get(actionId);
    if (!record || record.ownerId !== OWNER_ID) { sendError(response, 404, 'ACTION_NOT_FOUND', 'The action receipt was not found.'); return; }
    sendData(response, serializeReceiptMetadata(record));
    return;
  }
  if (method === 'POST' && parts.length === 5 && parts[4] === 'undo') {
    await undoTask(request, response, seed, idempotency, actionRecords, actionId);
    return;
  }
  sendError(response, 404, 'PREVIEW_NOT_FOUND', 'This action route is not part of the mock preview.');
}

async function undoTask(request, response, seed, idempotency, actionRecords, actionId) {
  const body = await readBody(request);
  if (!isRecord(body) || Object.keys(body).length > 0) { sendError(response, 400, 'VALIDATION_ERROR', 'Task undo accepts an empty object.'); return; }
  const key = readUndoKey(request, response);
  if (!key) return;
  const fingerprint = stableJson({ actionId, body: {} });
  const replayKey = undoSlot(actionId, key);
  const prior = idempotency.get(replayKey);
  if (prior) {
    if (prior.fingerprint !== fingerprint) { sendError(response, 409, 'IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was already used for a different undo request.'); return; }
    const original = actionRecords.get(actionId);
    const compensation = actionRecords.get(prior.undoActionId);
    const task = original ? seed.tasks.find((candidate) => candidate.id === original.targetId) : null;
    if (!original || !compensation || !task) { sendError(response, 404, 'ACTION_NOT_FOUND', 'The action receipt was not found.'); return; }
    sendUndoSuccess(response, seed, original, compensation, task, true);
    return;
  }
  const original = actionRecords.get(actionId);
  if (!original || original.ownerId !== OWNER_ID) { sendError(response, 404, 'ACTION_NOT_FOUND', 'The action receipt was not found.'); return; }
  const task = seed.tasks.find((candidate) => candidate.id === original.targetId);
  if (original.targetKind !== 'task' || !['task.update', 'task.move', 'task.archive'].includes(original.actionKind) || original.undoStatus !== 'available') {
    sendUndoConflict(response, seed, original, task ?? null, original.undoStatus === 'undone' ? 'already_undone' : 'not_reversible'); return;
  }
  if (!task) { sendUndoConflict(response, seed, original, null, 'target_missing'); return; }
  if (task.version !== original.postVersion) { sendUndoConflict(response, seed, original, task, 'changed'); return; }
  if (!isActiveWorkspace(seed, task.projectId)) { sendUndoConflict(response, seed, original, task, 'archived_workspace'); return; }

  let postSourceOrderVersion;
  let postDestinationOrderVersion;
  if (original.actionKind === 'task.move') {
    const beforeProject = original.reversibleFields.projectId?.before;
    const afterProject = original.reversibleFields.projectId?.after;
    const beforePosition = original.reversibleFields.position?.before;
    const afterPosition = original.reversibleFields.position?.after;
    if (!Object.hasOwn(original.reversibleFields, 'projectId') || !Object.hasOwn(original.reversibleFields, 'position') ||
        task.projectId !== afterProject || task.position !== afterPosition ||
        orderVersion(seed, beforeProject) !== original.outcome.sourceOrderVersion ||
        orderVersion(seed, afterProject) !== original.outcome.destinationOrderVersion) {
      sendUndoConflict(response, seed, original, task, 'changed'); return;
    }
    if (!isActiveWorkspace(seed, beforeProject)) { sendUndoConflict(response, seed, original, task, 'archived_workspace'); return; }
    const before = snapshotTask(task);
    const destinationPosition = Number(beforePosition);
    if (!Number.isSafeInteger(destinationPosition) || destinationPosition < 0 || destinationPosition > activeTasks(seed, beforeProject).length) {
      sendUndoConflict(response, seed, original, task, 'changed'); return;
    }
    insertAtPosition(seed, beforeProject, destinationPosition);
    task.projectId = beforeProject;
    task.position = destinationPosition;
    task.version += 1;
    task.updatedAt = new Date().toISOString();
    compactPositions(seed, before.projectId);
    postSourceOrderVersion = bumpOrder(seed, before.projectId);
    postDestinationOrderVersion = bumpOrder(seed, beforeProject);
  } else {
    if (orderVersion(seed, task.projectId) !== original.outcome.sourceOrderVersion) {
      sendUndoConflict(response, seed, original, task, 'changed'); return;
    }
    const before = snapshotTask(task);
    for (const [field, pair] of Object.entries(original.reversibleFields)) {
      if (!pair || !Object.hasOwn(pair, 'before') || !Object.hasOwn(pair, 'after') || task[field] !== pair.after && stableJson(task[field]) !== stableJson(pair.after)) {
        sendUndoConflict(response, seed, original, task, 'changed'); return;
      }
    }
    if (original.actionKind === 'task.archive') {
      if (task.status !== 'archived' || typeof original.reversibleFields.status?.before !== 'string' ||
          original.reversibleFields.archivedAt?.before !== null || task.archivedAt !== original.reversibleFields.archivedAt.after) {
        sendUndoConflict(response, seed, original, task, 'changed'); return;
      }
      const position = task.position;
      if (!Number.isSafeInteger(position) || position < 0 || position > activeTasks(seed, task.projectId).length) {
        sendUndoConflict(response, seed, original, task, 'changed'); return;
      }
      insertAtPosition(seed, task.projectId, position);
    }
    for (const [field, pair] of Object.entries(original.reversibleFields)) task[field] = cloneValue(pair.before);
    task.version += 1;
    task.updatedAt = new Date().toISOString();
    if (original.actionKind === 'task.archive') postSourceOrderVersion = bumpOrder(seed, task.projectId);
    else postSourceOrderVersion = orderVersion(seed, task.projectId);
  }

  const compensation = makeRecord({
    actionKind: 'undo', task, expectedVersion: original.postVersion, preVersion: original.postVersion,
    reversibleFields: {},
    outcome: { targetId: task.id, targetVersion: task.version,
      ...(postSourceOrderVersion === undefined ? {} : { sourceOrderVersion: postSourceOrderVersion }),
      ...(postDestinationOrderVersion === undefined ? {} : { destinationOrderVersion: postDestinationOrderVersion }) },
    undoStatus: 'not_reversible', undoOfActionId: original.id
  });
  actionRecords.set(compensation.id, compensation);
  original.undoStatus = 'undone';
  original.undoActionId = compensation.id;
  idempotency.set(replayKey, { fingerprint, undoActionId: compensation.id });
  sendUndoSuccess(response, seed, original, compensation, task, false);
}

function readIfMatch(request, response) {
  const match = request.headers['if-match']?.match(/^"([1-9]\d*)"$/u);
  const version = match?.[1] ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version > 2147483647) {
    sendError(response, 428, 'PRECONDITION_REQUIRED', 'A quoted task version is required.');
    return null;
  }
  return version;
}

function readMutationKey(request, response) {
  const key = typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'].trim() : '';
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(key)) {
    sendError(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required.');
    return null;
  }
  return key;
}

function readUndoKey(request, response) {
  const key = typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'].trim() : '';
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(key)) {
    sendError(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required.');
    return null;
  }
  return key;
}

function validOptionalVersion(value) {
  return value === undefined || Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}

function findReplay(idempotency, actionRecords, key, fingerprint, response) {
  const previous = idempotency.get(mutationSlot(key));
  if (!previous) return null;
  if (previous.fingerprint !== fingerprint) {
    sendError(response, 409, 'IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was already used for a different request.');
    return { handled: true };
  }
  const record = actionRecords.get(previous.actionId);
  if (!record) {
    sendError(response, 404, 'PROJECT_TASK_NOT_FOUND', 'Task not found.');
    return { handled: true };
  }
  return { handled: false, record };
}

function mutationSlot(key) {
  return `global-task-command:${OWNER_ID}:${key}`;
}

function undoSlot(actionId, key) {
  return `task-undo:${OWNER_ID}:${actionId}:${key}`;
}

function normalizeUpdate(body, task) {
  if (body.status !== undefined) {
    if (!STATUSES.has(body.status)) throw new Error('Choose a valid task status.');
    return { status: body.status };
  }
  const patch = {};
  if (body.title !== undefined) patch.title = taskTitle(body.title);
  if (body.details !== undefined) {
    if (body.details !== null && typeof body.details !== 'string') throw new Error('Task details must be plain text.');
    const details = typeof body.details === 'string' ? body.details.replace(/\r\n?/gu, '\n').trim() : '';
    if (Buffer.byteLength(details, 'utf8') > 4096) throw new Error('Task details must be no more than 4,096 bytes.');
    patch.details = details || null;
  }
  if (body.importance !== undefined || body.deadline !== undefined || body.subtasks !== undefined) {
    const planning = normalizePlanning(body, task);
    if (body.importance !== undefined) patch.importance = planning.importance;
    if (body.deadline !== undefined) patch.deadline = planning.deadline;
    if (body.subtasks !== undefined) patch.subtasks = planning.subtasks;
  }
  if (Object.keys(patch).length === 0) throw new Error('Provide at least one task field to update.');
  return patch;
}

function applyUpdate(task, patch) {
  const beforeStatus = task.status;
  const planning = normalizePlanning(patch, task);
  const checklist = resolveChecklist(task, patch, planning);
  if (patch.title !== undefined) task.title = patch.title;
  if (patch.details !== undefined) task.details = patch.details;
  if (patch.importance !== undefined) task.importance = patch.importance;
  if (patch.deadline !== undefined) task.deadline = patch.deadline;
  if (patch.status !== undefined || patch.subtasks !== undefined) task.subtasks = checklist.subtasks;
  task.status = checklist.status;
  if (task.status === 'done') {
    task.completedAt = beforeStatus === 'done' ? task.completedAt : new Date().toISOString();
  } else if (beforeStatus === 'done') {
    task.completedAt = null;
  }
}

function snapshotTask(task) {
  return cloneValue(task);
}

function reversibleDiff(before, after) {
  const fields = ['title', 'details', 'status', 'importance', 'deadline', 'subtasks', 'completedAt'];
  return Object.fromEntries(fields.filter((field) => stableJson(before[field]) !== stableJson(after[field]))
    .map((field) => [field, { before: cloneValue(before[field]), after: cloneValue(after[field]) }]));
}

function makeRecord(input) {
  return {
    id: randomUUID(), ownerId: OWNER_ID, actionKind: input.actionKind, targetKind: 'task', targetId: input.task.id,
    expectedVersion: input.expectedVersion ?? null, preVersion: input.preVersion, postVersion: input.task.version,
    reversibleFields: cloneValue(input.reversibleFields), outcome: cloneValue(input.outcome), undoStatus: input.undoStatus,
    undoOfActionId: input.undoOfActionId ?? null, undoActionId: null, createdAt: new Date().toISOString()
  };
}

function serializeAction(record) {
  return {
    id: record.id, actionKind: record.actionKind, targetKind: record.targetKind, targetId: record.targetId,
    preVersion: record.preVersion, postVersion: record.postVersion, outcome: record.outcome,
    undoStatus: record.undoStatus, undoActionId: record.undoActionId, createdAt: record.createdAt
  };
}

function serializeCompactReceipt(record) {
  return { id: record.id, actionKind: record.actionKind, undoStatus: record.undoStatus, outcome: record.outcome };
}

function serializeReceiptMetadata(record) {
  return {
    id: record.id, actionKind: record.actionKind, targetKind: record.targetKind, targetId: record.targetId,
    postVersion: record.postVersion, undoStatus: record.undoStatus, undoActionId: record.undoActionId
  };
}

function sendMutation(response, seed, task, record, replayed) {
  sendData(response, { item: taskItem(seed, task), receipt: serializeCompactReceipt(record), replayed }, 200, { ETag: `"${task.version}"` });
}

function sendUndoSuccess(response, seed, original, compensation, task, replayed) {
  sendData(response, {
    originalAction: serializeAction(original),
    undoReceipt: serializeAction(compensation),
    target: { kind: 'task', item: taskItem(seed, task) },
    replayed
  });
}

function sendUndoConflict(response, seed, original, task, reason) {
  response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({
    data: { originalAction: serializeAction(original), target: task ? { kind: 'task', item: taskItem(seed, task) } : null, reason },
    error: { code: 'ACTION_UNDO_CONFLICT', message: 'The saved action cannot be undone because the task has changed.' }
  }));
}

function canMutateTask(seed, task, response) {
  if (task.status === 'archived') {
    sendError(response, 409, 'PROJECT_TASK_ARCHIVED', 'This task is archived and cannot be changed.');
    return false;
  }
  if (!isActiveWorkspace(seed, task.projectId)) {
    sendError(response, 409, 'PROJECT_TASK_PROJECT_ARCHIVED', 'The workspace is archived.');
    return false;
  }
  return true;
}

function isActiveWorkspace(seed, projectId) {
  if (projectId === null) return true;
  return findProject(seed, projectId)?.status === 'active';
}

function activeTasks(seed, projectId) {
  return seed.tasks.filter((task) => task.projectId === projectId && task.status !== 'archived').sort((left, right) => left.position - right.position);
}

function compactPositions(seed, projectId) {
  activeTasks(seed, projectId).forEach((task, position) => { task.position = position; });
}

function insertAtPosition(seed, projectId, position) {
  for (const task of activeTasks(seed, projectId)) {
    if (task.position >= position) task.position += 1;
  }
}

function orderVersion(seed, projectId) {
  if (projectId === null) return seed.taskOrders.inbox ?? 1;
  return seed.taskOrders[projectId] ?? 1;
}

function bumpOrder(seed, projectId) {
  if (projectId === null) {
    seed.taskOrders.inbox = (seed.taskOrders.inbox ?? 1) + 1;
    return seed.taskOrders.inbox;
  }
  seed.taskOrders[projectId] = (seed.taskOrders[projectId] ?? 1) + 1;
  return seed.taskOrders[projectId];
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

async function createGlobalTask(request, response, seed, idempotency) {
  const key = validIdempotencyKey(request);
  const body = await readBody(request);
  if (!isRecord(body) || Object.keys(body).some((field) => !['title', 'details', 'workspaceId', 'importance', 'deadline', 'subtasks'].includes(field))) {
    sendError(response, 400, 'VALIDATION_ERROR', 'Provide a valid task capture.');
    return;
  }
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!key) { sendError(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'An idempotency key is required.'); return; }
  if (!title || Array.from(title).length > 120 || /[\u0000-\u001f\u007f]/u.test(title)) { sendError(response, 400, 'VALIDATION_ERROR', 'Enter a valid task title.'); return; }
  if (!Object.hasOwn(body, 'workspaceId') || body.workspaceId !== null && (typeof body.workspaceId !== 'string' || !UUID.test(body.workspaceId)) ||
      body.importance !== 'medium' || body.deadline !== null || body.details !== null || !Array.isArray(body.subtasks) || body.subtasks.length !== 0) {
    sendError(response, 400, 'VALIDATION_ERROR', 'This capture endpoint accepts a default task only.');
    return;
  }
  const workspaceId = body.workspaceId;
  const workspace = workspaceId === null ? null : findProject(seed, workspaceId);
  if (workspaceId !== null && !workspace) { sendError(response, 404, 'PROJECT_NOT_FOUND', 'Choose an existing workspace.'); return; }
  if (workspace?.status === 'archived') { sendError(response, 409, 'PROJECT_TASK_PROJECT_ARCHIVED', 'The workspace is archived.'); return; }
  const fingerprint = JSON.stringify({ title, workspaceId, importance: 'medium', deadline: null, details: null, subtasks: [] });
  const replayKey = `global-task:${OWNER_ID}:${key}`;
  const previous = idempotency.get(replayKey);
  if (previous) {
    if (previous.fingerprint !== fingerprint) { sendError(response, 409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different task.'); return; }
    sendData(response, { ...previous.result, replayed: true }, 200, { Location: `/api/v1/tasks/${previous.result.item.task.id}`, ETag: '"1"' });
    return;
  }
  const task = buildTask(workspaceId, { ...body, title }, activeTasks(seed, workspaceId).length);
  seed.tasks.push(task);
  const result = { item: taskItem(seed, task), receipt: { id: randomUUID(), actionKind: 'task.create', undoStatus: 'available', outcome: { targetId: task.id, targetVersion: task.version, destinationOrderVersion: bumpOrder(seed, workspaceId) } }, replayed: false };
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
