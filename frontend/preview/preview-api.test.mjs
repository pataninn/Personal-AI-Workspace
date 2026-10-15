import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, test } from 'node:test';

import viteConfig from '../vite.config.mjs';
import { createPreviewApi } from './preview-api.mjs';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function startPreview() {
  const api = createPreviewApi();
  const server = createServer((request, response) => {
    void api.handle(request, response);
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { api, origin: `http://127.0.0.1:${server.address().port}` };
}

async function signIn(origin) {
  const response = await fetch(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'made-up-preview-password' })
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

function headers(cookie, extra = {}) {
  return { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': 'preview-only-csrf-token', ...extra };
}

const PROJECT_ID = '873c096a-bc57-4a0c-85da-10d4febde96b';
const CONVERSATION_ID = '489541da-57a5-416d-afb6-45b19ad7bc98';

test('Home overview ranks dated tasks before undated importance and updates activity', async () => {
  const { origin } = await startPreview(); const cookie = await signIn(origin);
  const response = await fetch(`${origin}/api/v1/projects/overview`, { headers: headers(cookie) });
  const overview = (await response.json()).data;
  assert.equal(response.status, 200);
  assert.equal(overview.projects[0].id, PROJECT_ID);
  assert.equal(overview.tasks[0].deadline, '2026-10-10');
  assert.equal(overview.tasks[1].importance, 'urgent');
  assert.equal(overview.tasks[1].deadline, null);
});

test('global task capture is idempotent and increments the canonical Inbox count once', async () => {
  const { origin } = await startPreview(); const cookie = await signIn(origin);
  const countUrl = `${origin}/api/v1/tasks/inbox/count`;
  assert.equal((await (await fetch(countUrl, { headers: headers(cookie) })).json()).data.count, 0);
  const request = { title: 'Send the proposal', details: null, workspaceId: null, importance: 'medium', deadline: null, subtasks: [] };
  const create = () => fetch(`${origin}/api/v1/tasks`, { method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'home-capture-intent-1' }), body: JSON.stringify(request) });
  const first = await create(); const firstBody = (await first.json()).data;
  const replay = await create(); const replayBody = (await replay.json()).data;
  assert.equal(first.status, 201); assert.equal(firstBody.item.task.projectId, null); assert.equal(firstBody.item.collection, 'inbox');
  assert.equal(firstBody.item.task.status, 'todo'); assert.equal(firstBody.item.task.importance, 'medium');
  assert.equal(replay.status, 200); assert.equal(replayBody.replayed, true); assert.equal(replayBody.item.task.id, firstBody.item.task.id);
  assert.equal((await (await fetch(countUrl, { headers: headers(cookie) })).json()).data.count, 1);
  const detail = await fetch(`${origin}/api/v1/tasks/${firstBody.item.task.id}`, { headers: headers(cookie) });
  assert.equal((await detail.json()).data.task.id, firstBody.item.task.id);
});

test('global task reads filter collections, retain stable keyset pages, and reject cursor reuse', async () => {
  const { origin } = await startPreview(); const cookie = await signIn(origin);
  const first = await (await fetch(`${origin}/api/v1/tasks?limit=1`, { headers: headers(cookie) })).json();
  assert.equal(first.data.items.length, 1); assert.ok(first.data.nextCursor);
  const secondResponse = await fetch(`${origin}/api/v1/tasks?limit=1&cursor=${encodeURIComponent(first.data.nextCursor)}`, { headers: headers(cookie) });
  const second = (await secondResponse.json()).data;
  assert.equal(second.items.length, 1); assert.notEqual(second.items[0].task.id, first.data.items[0].task.id);
  const inbox = await (await fetch(`${origin}/api/v1/tasks?inboxOnly=true`, { headers: headers(cookie) })).json();
  assert.deepEqual(inbox.data.items, []);
  const wrongScope = await fetch(`${origin}/api/v1/tasks?q=another-filter&limit=1&cursor=${encodeURIComponent(first.data.nextCursor)}`, { headers: headers(cookie) });
  assert.equal(wrongScope.status, 400); assert.equal((await wrongScope.json()).error.code, 'TASK_CURSOR_INVALID');
});

test('global task edit receipts are safe to reload, replay, and undo only once', async () => {
  const { origin } = await startPreview(); const cookie = await signIn(origin);
  const listed = await fetch(`${origin}/api/v1/tasks?limit=10`, { headers: headers(cookie) });
  const originalItem = (await listed.json()).data.items[0];
  const taskId = originalItem.task.id;
  const updated = await fetch(`${origin}/api/v1/tasks/${taskId}`, {
    method: 'PATCH', headers: headers(cookie, { 'If-Match': `"${originalItem.task.version}"`, 'Idempotency-Key': 'task-edit-intent-1' }),
    body: JSON.stringify({ title: 'Edited in preview' })
  });
  const updateBody = (await updated.json()).data;
  assert.equal(updated.status, 200);
  assert.equal(updated.headers.get('etag'), `"${originalItem.task.version + 1}"`);
  assert.equal(updateBody.item.task.title, 'Edited in preview');
  assert.deepEqual(updateBody.receipt, {
    id: updateBody.receipt.id,
    actionKind: 'task.update',
    undoStatus: 'available',
    outcome: { targetId: taskId, targetVersion: originalItem.task.version + 1, sourceOrderVersion: 1 }
  });

  const replay = await fetch(`${origin}/api/v1/tasks/${taskId}`, {
    method: 'PATCH', headers: headers(cookie, { 'If-Match': `"${originalItem.task.version}"`, 'Idempotency-Key': 'task-edit-intent-1' }),
    body: JSON.stringify({ title: 'Edited in preview' })
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.replayed, true);
  const changedKeyReuse = await fetch(`${origin}/api/v1/tasks/${taskId}`, {
    method: 'PATCH', headers: headers(cookie, { 'If-Match': `"${originalItem.task.version}"`, 'Idempotency-Key': 'task-edit-intent-1' }),
    body: JSON.stringify({ title: 'Different request' })
  });
  assert.equal(changedKeyReuse.status, 409);
  assert.equal((await changedKeyReuse.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');

  const actionId = updateBody.receipt.id;
  const metadataResponse = await fetch(`${origin}/api/v1/actions/${actionId}`, { headers: headers(cookie) });
  const metadata = (await metadataResponse.json()).data;
  assert.equal(metadataResponse.status, 200);
  assert.deepEqual(Object.keys(metadata).sort(), ['actionKind', 'id', 'postVersion', 'targetId', 'targetKind', 'undoActionId', 'undoStatus'].sort());
  assert.equal(metadata.targetKind, 'task');
  assert.equal(metadata.targetId, taskId);
  assert.equal(metadata.undoStatus, 'available');
  assert.equal('reversibleFields' in metadata, false);

  const undoUrl = `${origin}/api/v1/actions/${actionId}/undo`;
  const undo = await fetch(undoUrl, { method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'task-edit-undo-1' }), body: '{}' });
  const undoBody = (await undo.json()).data;
  assert.equal(undo.status, 200);
  assert.equal(undoBody.originalAction.undoStatus, 'undone');
  assert.equal(undoBody.undoReceipt.actionKind, 'undo');
  assert.equal(undoBody.target.kind, 'task');
  assert.equal(undoBody.target.item.task.title, originalItem.task.title);
  assert.equal(undoBody.target.item.task.version, originalItem.task.version + 2);
  assert.equal('reversibleFields' in undoBody.undoReceipt, false);

  const afterUndo = (await (await fetch(`${origin}/api/v1/actions/${actionId}`, { headers: headers(cookie) })).json()).data;
  assert.equal(afterUndo.undoStatus, 'undone');
  assert.equal(afterUndo.undoActionId, undoBody.undoReceipt.id);
  const undoReplay = await fetch(undoUrl, { method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'task-edit-undo-1' }), body: '{}' });
  assert.equal(undoReplay.status, 200);
  assert.equal((await undoReplay.json()).data.replayed, true);
  const secondUndo = await fetch(undoUrl, { method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'task-edit-undo-2' }), body: '{}' });
  assert.equal(secondUndo.status, 409);
  assert.equal((await secondUndo.json()).data.reason, 'already_undone');
});

test('moves tasks to a rootless planning workspace and reverses archive without changing the task id', async () => {
  const { origin } = await startPreview(); const cookie = await signIn(origin);
  const planningResponse = await fetch(`${origin}/api/v1/projects`, {
    method: 'POST', headers: headers(cookie), body: JSON.stringify({ name: 'Preview plan', workspaceMode: 'planning', objective: 'Move tasks here' })
  });
  const planning = (await planningResponse.json()).data;
  assert.equal(planningResponse.status, 201);
  assert.equal(planning.relativeRoot, null);
  const page = await fetch(`${origin}/api/v1/tasks?limit=10`, { headers: headers(cookie) });
  const taskItem = (await page.json()).data.items.find((item) => item.workspace?.id === PROJECT_ID);
  const taskId = taskItem.task.id;

  const move = await fetch(`${origin}/api/v1/tasks/${taskId}/move`, {
    method: 'POST', headers: headers(cookie, { 'If-Match': `"${taskItem.task.version}"`, 'Idempotency-Key': 'task-move-intent-1' }),
    body: JSON.stringify({ workspaceId: planning.id, expectedSourceOrderVersion: 1, expectedDestinationOrderVersion: 1 })
  });
  const moved = (await move.json()).data;
  assert.equal(move.status, 200);
  assert.equal(moved.item.task.id, taskId);
  assert.equal(moved.item.workspace.id, planning.id);
  assert.equal(moved.receipt.actionKind, 'task.move');
  assert.deepEqual(moved.receipt.outcome, { targetId: taskId, targetVersion: taskItem.task.version + 1, sourceOrderVersion: 2, destinationOrderVersion: 2 });

  const moveUndo = await fetch(`${origin}/api/v1/actions/${moved.receipt.id}/undo`, {
    method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'task-move-undo-1' }), body: '{}'
  });
  const restored = (await moveUndo.json()).data;
  assert.equal(moveUndo.status, 200);
  assert.equal(restored.target.item.task.id, taskId);
  assert.equal(restored.target.item.task.projectId, PROJECT_ID);
  assert.equal(restored.target.item.task.version, taskItem.task.version + 2);

  const archive = await fetch(`${origin}/api/v1/tasks/${taskId}/archive`, {
    method: 'POST', headers: headers(cookie, { 'If-Match': `"${taskItem.task.version + 2}"`, 'Idempotency-Key': 'task-archive-intent-1' }), body: '{}'
  });
  const archived = (await archive.json()).data;
  assert.equal(archive.status, 200);
  assert.equal(archived.item.task.id, taskId);
  assert.equal(archived.item.task.status, 'archived');
  assert.equal((await fetch(`${origin}/api/v1/tasks/${taskId}`, { headers: headers(cookie) })).status, 404);
  assert.equal((await fetch(`${origin}/api/v1/tasks/${taskId}?includeArchived=true`, { headers: headers(cookie) })).status, 200);

  const archiveUndo = await fetch(`${origin}/api/v1/actions/${archived.receipt.id}/undo`, {
    method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'task-archive-undo-1' }), body: '{}'
  });
  const unarchived = (await archiveUndo.json()).data;
  assert.equal(archiveUndo.status, 200);
  assert.equal(unarchived.target.item.task.id, taskId);
  assert.equal(unarchived.target.item.task.status, taskItem.task.status);
  assert.equal(unarchived.target.item.task.version, taskItem.task.version + 4);
});

test('receipt and undo routes hide unknown action IDs and reject stale undo state', async () => {
  const { origin } = await startPreview(); const cookie = await signIn(origin);
  const unknown = '2a5a518e-d8ec-4cf4-9cbd-18d2d2c4fb5e';
  const missing = await fetch(`${origin}/api/v1/actions/${unknown}`, { headers: headers(cookie) });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'ACTION_NOT_FOUND');

  const item = (await (await fetch(`${origin}/api/v1/tasks?limit=10`, { headers: headers(cookie) })).json()).data.items[0];
  const first = await fetch(`${origin}/api/v1/tasks/${item.task.id}`, {
    method: 'PATCH', headers: headers(cookie, { 'If-Match': `"${item.task.version}"`, 'Idempotency-Key': 'task-stale-undo-1' }),
    body: JSON.stringify({ title: 'First edit' })
  });
  const firstReceipt = (await first.json()).data.receipt;
  const second = await fetch(`${origin}/api/v1/tasks/${item.task.id}`, {
    method: 'PATCH', headers: headers(cookie, { 'If-Match': `"${item.task.version + 1}"`, 'Idempotency-Key': 'task-stale-undo-2' }),
    body: JSON.stringify({ title: 'Second edit' })
  });
  assert.equal(second.status, 200);
  const undo = await fetch(`${origin}/api/v1/actions/${firstReceipt.id}/undo`, {
    method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'task-stale-undo-attempt' }), body: '{}'
  });
  assert.equal(undo.status, 409);
  const body = await undo.json();
  assert.equal(body.error.code, 'ACTION_UNDO_CONFLICT');
  assert.equal(body.data.reason, 'changed');
  assert.equal(body.data.target.item.task.title, 'Second edit');
});

test('task metadata, checklists, completion/reopening and permanent removal use current versions', async () => {
  const { origin } = await startPreview(); const cookie = await signIn(origin);
  const endpoint = `${origin}/api/v1/projects/${PROJECT_ID}/tasks`;
  const created = await fetch(endpoint, { method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'task-checklist-create' }),
    body: JSON.stringify({ title: 'Test checklist', importance: 'low', deadline: '2027-01-01', subtasks: [{ title: 'First item' }] }) });
  const task = (await created.json()).data.task;
  assert.equal(created.status, 201); assert.equal(task.importance, 'low'); assert.equal(task.subtasks[0].completed, false);
  const completed = await fetch(`${endpoint}/${task.id}`, { method: 'PATCH', headers: headers(cookie, { 'If-Match': '"1"' }),
    body: JSON.stringify({ subtasks: task.subtasks.map((item) => ({ ...item, completed: true })) }) });
  const done = (await completed.json()).data.task; assert.equal(done.status, 'done');
  const reopened = await fetch(`${endpoint}/${task.id}`, { method: 'PATCH', headers: headers(cookie, { 'If-Match': '"2"' }),
    body: JSON.stringify({ subtasks: done.subtasks.map((item) => ({ ...item, completed: false })) }) });
  assert.equal((await reopened.json()).data.task.status, 'todo');
  assert.equal((await fetch(`${endpoint}/${task.id}`, { method: 'DELETE', headers: headers(cookie, { 'If-Match': '"2"' }) })).status, 409);
  assert.equal((await fetch(`${endpoint}/${task.id}`, { method: 'DELETE', headers: headers(cookie, { 'If-Match': '"3"' }) })).status, 200);
  const listing = await fetch(endpoint, { headers: headers(cookie) });
  assert.equal((await listing.json()).data.tasks.some((item) => item.id === task.id), false);
});

test('suggestions stay scoped to the current chat and accepted titles become checklist items', async () => {
  const { origin } = await startPreview(); const cookie = await signIn(origin);
  const endpoint = `${origin}/api/v1/projects/${PROJECT_ID}/task-suggestions`;
  const listing = await fetch(`${endpoint}?conversationId=${CONVERSATION_ID}&status=all`, { headers: headers(cookie) });
  const suggestion = (await listing.json()).data.taskSuggestions[0];
  const decision = await fetch(`${endpoint}/${suggestion.id}`, { method: 'PATCH', headers: headers(cookie, { 'If-Match': '"1"' }), body: JSON.stringify({ status: 'accepted' }) });
  const result = (await decision.json()).data;
  assert.equal(decision.status, 200); assert.equal(result.task.importance, 'medium');
  assert.equal(result.task.subtasks.length, 2); assert.equal(result.task.subtasks[0].completed, false);
  const unrelated = await fetch(`${endpoint}?conversationId=11111111-1111-4111-8111-111111111111&status=all`, { headers: headers(cookie) });
  assert.deepEqual((await unrelated.json()).data.taskSuggestions, []);
});

test('files support upload, raw download, stale-safe edits and deletion without affecting other files', async () => {
  const { origin } = await startPreview(); const cookie = await signIn(origin);
  const endpoint = `${origin}/api/v1/projects/${PROJECT_ID}/files`;
  const upload = await fetch(`${endpoint}/upload?path=preview.txt`, { method: 'POST', headers: headers(cookie, { 'Content-Type': 'application/octet-stream' }), body: 'Uploaded preview' });
  assert.equal(upload.status, 201);
  const first = (await (await fetch(`${endpoint}/content?path=preview.txt`, { headers: headers(cookie) })).json()).data;
  const edit = await fetch(`${endpoint}/content`, { method: 'PUT', headers: headers(cookie), body: JSON.stringify({ path: 'preview.txt', content: 'Edited preview', expectedHash: first.sourceHash }) });
  const changed = (await edit.json()).data; assert.equal(edit.status, 200);
  const stale = await fetch(`${endpoint}/content`, { method: 'PUT', headers: headers(cookie), body: JSON.stringify({ path: 'preview.txt', content: 'Stale preview', expectedHash: first.sourceHash }) });
  assert.equal(stale.status, 409);
  const download = await fetch(`${endpoint}/download?path=preview.txt`, { headers: headers(cookie) });
  assert.equal(await download.text(), 'Edited preview'); assert.equal(download.headers.get('etag'), `"${changed.hash}"`);
  const removed = await fetch(`${endpoint}/content?path=preview.txt`, { method: 'DELETE', headers: headers(cookie, { 'If-Match': `"${changed.hash}"` }) });
  assert.equal(removed.status, 204);
  assert.equal((await fetch(`${endpoint}/content?path=README.md`, { headers: headers(cookie) })).status, 200);
});

test('project removal clears app records and retains files for the same root after reattachment', async () => {
  const { origin } = await startPreview(); const cookie = await signIn(origin);
  const before = (await (await fetch(`${origin}/api/v1/projects/${PROJECT_ID}/files/content?path=README.md`, { headers: headers(cookie) })).json()).data;
  const removed = await fetch(`${origin}/api/v1/projects/${PROJECT_ID}`, { method: 'DELETE', headers: headers(cookie, { 'If-Match': '1' }) });
  assert.equal(removed.status, 204);
  assert.equal((await fetch(`${origin}/api/v1/projects/${PROJECT_ID}/tasks`, { headers: headers(cookie) })).status, 404);
  assert.equal((await fetch(`${origin}/api/v1/conversations/${CONVERSATION_ID}?projectId=${PROJECT_ID}`, { headers: headers(cookie) })).status, 404);
  const attached = await fetch(`${origin}/api/v1/projects`, { method: 'POST', headers: headers(cookie), body: JSON.stringify({ name: 'Reattached', relativeRoot: 'apps/website' }) });
  const id = (await attached.json()).data.id;
  const after = (await (await fetch(`${origin}/api/v1/projects/${id}/files/content?path=README.md`, { headers: headers(cookie) })).json()).data;
  assert.equal(after.content, before.content);
});

test('new destructive/file methods require CSRF and direct preview chat stays local with Markdown', async () => {
  const { origin } = await startPreview(); const cookie = await signIn(origin);
  assert.equal((await fetch(`${origin}/api/v1/projects/${PROJECT_ID}`, { method: 'DELETE', headers: { Cookie: cookie, 'If-Match': '1' } })).status, 403);
  const chat = await fetch(`${origin}/api/v1/projects/${PROJECT_ID}/chat-runs`, { method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'direct-chat-local-preview' }), body: JSON.stringify({ conversationId: CONVERSATION_ID, request: 'Suggest a homepage plan.' }) });
  assert.equal(chat.status, 200); const run = (await chat.json()).data;
  assert.equal(run.status, 'succeeded'); assert.equal(run.providerTransmission, 'not_started_confirmed');
  const history = await fetch(`${origin}/api/v1/conversations/${CONVERSATION_ID}?projectId=${PROJECT_ID}`, { headers: headers(cookie) });
  const latest = (await history.json()).data.messages.at(-1); assert.equal(latest.role, 'assistant'); assert.match(latest.content, /```ts/u);
});

async function createAiRun(origin, cookie, key, request, context = {}) {
  const response = await fetch(`${origin}/api/v1/projects/${PROJECT_ID}/ai-runs`, {
    method: 'POST',
    headers: headers(cookie, { 'Idempotency-Key': key }),
    body: JSON.stringify({ conversationId: CONVERSATION_ID, request, context })
  });
  return { response, body: await response.json() };
}

test('requires a mock session and allows login with made-up input', async () => {
  const { origin } = await startPreview();
  const unauthenticated = await fetch(`${origin}/api/v1/auth/session`);
  assert.equal(unauthenticated.status, 401);
  const cookie = await signIn(origin);
  const session = await fetch(`${origin}/api/v1/auth/session`, { headers: { Cookie: cookie } });
  assert.equal((await session.json()).data.principal.displayName, 'Preview user');
  const logout = await fetch(`${origin}/api/v1/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/u);
});

test('shows seeded projects and supports create, archive, and restore', async () => {
  const { origin } = await startPreview();
  const cookie = await signIn(origin);
  const list = await fetch(`${origin}/api/v1/projects`, { headers: { Cookie: cookie } });
  const projects = (await list.json()).data.projects;
  assert.equal(projects.length, 2);
  const created = await fetch(`${origin}/api/v1/projects`, {
    method: 'POST', headers: headers(cookie), body: JSON.stringify({ name: 'My preview', relativeRoot: 'apps/my-preview' })
  });
  assert.equal(created.status, 201);
  const project = (await created.json()).data;
  const archive = await fetch(`${origin}/api/v1/projects/${project.id}`, {
    method: 'PATCH', headers: headers(cookie, { 'If-Match': '1' }), body: JSON.stringify({ status: 'archived' })
  });
  assert.equal((await archive.json()).data.status, 'archived');
  const restore = await fetch(`${origin}/api/v1/projects/${project.id}`, {
    method: 'PATCH', headers: headers(cookie, { 'If-Match': '2' }), body: JSON.stringify({ status: 'active' })
  });
  assert.equal((await restore.json()).data.status, 'active');
});

test('creates rootless planning metadata and refuses file-backed capabilities without a root', async () => {
  const { origin } = await startPreview();
  const cookie = await signIn(origin);
  const created = await fetch(`${origin}/api/v1/projects`, {
    method: 'POST', headers: headers(cookie),
    body: JSON.stringify({ name: 'Launch plan', workspaceMode: 'planning', objective: '  Track the launch  ' })
  });
  assert.equal(created.status, 201);
  const project = (await created.json()).data;
  assert.equal(project.relativeRoot, null);
  assert.equal(project.objective, 'Track the launch');
  assert.equal(project.workspaceMode, 'planning');
  assert.deepEqual(project.capabilities, { planning: true, fileAccess: false });

  const detail = await fetch(`${origin}/api/v1/projects/${project.id}`, { headers: { Cookie: cookie } });
  assert.deepEqual((await detail.json()).data, project);
  const overview = await fetch(`${origin}/api/v1/projects/overview`, { headers: { Cookie: cookie } });
  const listed = (await overview.json()).data.projects.find((item) => item.id === project.id);
  assert.equal(listed.relativeRoot, null);
  assert.equal(listed.capabilities.fileAccess, false);

  const filePaths = [
    `${origin}/api/v1/projects/${project.id}/files/tree`,
    `${origin}/api/v1/projects/${project.id}/chat-context`,
    `${origin}/api/v1/projects/${project.id}/file-history?path=README.md`
  ];
  for (const url of filePaths) {
    const response = await fetch(url, { headers: { Cookie: cookie } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'PROJECT_ROOT_NOT_ATTACHED');
  }
  const run = await fetch(`${origin}/api/v1/projects/${project.id}/ai-runs`, {
    method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'planning-project-run' }),
    body: JSON.stringify({ conversationId: CONVERSATION_ID, request: 'Run a check', context: {} })
  });
  assert.equal(run.status, 409);
  assert.equal((await run.json()).error.code, 'PROJECT_ROOT_NOT_ATTACHED');
});

test('preserves rooted compatibility and rejects inconsistent planning mode requests', async () => {
  const { origin } = await startPreview();
  const cookie = await signIn(origin);
  const wrongRootMode = await fetch(`${origin}/api/v1/projects`, {
    method: 'POST', headers: headers(cookie),
    body: JSON.stringify({ name: 'Bad plan', workspaceMode: 'planning', relativeRoot: 'notes' })
  });
  assert.equal(wrongRootMode.status, 400);
  const missingRoot = await fetch(`${origin}/api/v1/projects`, {
    method: 'POST', headers: headers(cookie), body: JSON.stringify({ name: 'Missing root' })
  });
  assert.equal(missingRoot.status, 400);
  const workspaceRoot = await fetch(`${origin}/api/v1/projects`, {
    method: 'POST', headers: headers(cookie), body: JSON.stringify({ name: 'Whole workspace', relativeRoot: '.' })
  });
  assert.equal(workspaceRoot.status, 409);
  assert.equal((await workspaceRoot.json()).error.code, 'PROJECT_ROOT_OVERLAP');
});

test('supports seeded history, new conversations, and idempotent message retries', async () => {
  const { origin } = await startPreview();
  const cookie = await signIn(origin);
  const projectId = '873c096a-bc57-4a0c-85da-10d4febde96b';
  const list = await fetch(`${origin}/api/v1/projects/${projectId}/conversations`, { headers: { Cookie: cookie } });
  assert.equal((await list.json()).data.conversations.length, 1);
  const created = await fetch(`${origin}/api/v1/projects/${projectId}/conversations`, {
    method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'new-conversation' }), body: JSON.stringify({ title: 'Design review' })
  });
  assert.equal(created.status, 201);
  const conversation = (await created.json()).data;
  const replay = await fetch(`${origin}/api/v1/projects/${projectId}/conversations`, {
    method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'new-conversation' }), body: JSON.stringify({ title: 'Design review' })
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.id, conversation.id);
  const url = `${origin}/api/v1/conversations/${conversation.id}/messages?projectId=${projectId}`;
  const options = { method: 'POST', headers: headers(cookie, { 'Idempotency-Key': 'one-message' }), body: JSON.stringify({ content: 'Try this layout.' }) };
  const first = await fetch(url, options);
  const firstMessage = (await first.json()).data;
  assert.equal(first.status, 201);
  const retry = await fetch(url, options);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).data.id, firstMessage.id);
  const history = await fetch(`${origin}/api/v1/conversations/${conversation.id}?projectId=${projectId}`, { headers: { Cookie: cookie } });
  assert.deepEqual((await history.json()).data.messages.map((message) => message.id), [firstMessage.id]);
});

test('does not expose the preview mock through unknown API routes', async () => {
  const { origin } = await startPreview();
  const cookie = await signIn(origin);
  const response = await fetch(`${origin}/api/v1/runs`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'PREVIEW_NOT_FOUND');
});

test('creates a metadata-only run and reaches fake readiness after exact approval', async () => {
  const { origin } = await startPreview();
  const cookie = await signIn(origin);
  const created = await createAiRun(origin, cookie, 'ai-run-approve', 'Inspect the seeded project.', { relativePaths: ['src/index.ts'], includeRecentMessages: true });
  assert.equal(created.response.status, 202);
  assert.equal(created.body.data.run.status, 'pending_approval');
  assert.equal(created.body.data.run.decision, 'pending');
  assert.deepEqual(created.body.data.manifest.content.categories, ['Request', 'Recent conversation', 'Project files']);
  assert.deepEqual(created.body.data.manifest.content.relativePaths, ['src/index.ts']);
  assert.equal(created.body.data.manifest.content.messageCount, 1);
  assert.equal('request' in created.body.data.run, false);
  assert.equal('request' in created.body.data.manifest, false);

  const replay = await createAiRun(origin, cookie, 'ai-run-approve', 'Inspect the seeded project.', { relativePaths: ['src/index.ts'], includeRecentMessages: true });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.data.run.runId, created.body.data.run.runId);

  const manifestResponse = await fetch(`${origin}/api/v1/ai-runs/${created.body.data.run.runId}/egress-manifest`, { headers: { Cookie: cookie } });
  const manifestBody = await manifestResponse.json();
  assert.equal(manifestBody.data.manifestHash, created.body.data.manifest.manifestHash);

  const decision = await fetch(`${origin}/api/v1/ai-runs/${created.body.data.run.runId}/egress-decision`, {
    method: 'POST',
    headers: headers(cookie, { 'Idempotency-Key': 'ai-decision-approve' }),
    body: JSON.stringify({ manifestHash: created.body.data.manifest.manifestHash, decision: 'approve' })
  });
  const decisionBody = await decision.json();
  assert.equal(decision.status, 200);
  assert.equal(decisionBody.data.run.status, 'ready');
  assert.equal(decisionBody.data.run.decision, 'approved');
  assert.deepEqual(decisionBody.data.run.runtime, { kind: 'fake', sandboxReady: true });
  assert.match(decisionBody.data.run.safeMessage, /private run environment ready/iu);
  assert.doesNotMatch(JSON.stringify(decisionBody), /NVIDIA_API_KEY|preview-secret|\/workspace/iu);
});

test('records rejection without staging or fake runtime readiness', async () => {
  const { origin } = await startPreview();
  const cookie = await signIn(origin);
  const created = await createAiRun(origin, cookie, 'ai-run-reject', 'Keep this request local.');
  const decision = await fetch(`${origin}/api/v1/ai-runs/${created.body.data.run.runId}/egress-decision`, {
    method: 'POST',
    headers: headers(cookie, { 'Idempotency-Key': 'ai-decision-reject' }),
    body: JSON.stringify({ manifestHash: created.body.data.manifest.manifestHash, decision: 'reject' })
  });
  const body = await decision.json();
  assert.equal(decision.status, 200);
  assert.equal(body.data.run.status, 'rejected');
  assert.equal(body.data.run.decision, 'rejected');
  assert.equal(body.data.run.providerTransmission, 'not_started_confirmed');
  assert.equal('runtime' in body.data.run, false);
  assert.equal(body.data.manifest.preConsentNotice, 'Nothing was copied to the run staging area or sent to NVIDIA.');
});

test('reviews and applies a bounded fake proposed change set only after exact approval', async () => {
  const { origin } = await startPreview();
  const cookie = await signIn(origin);
  const created = await createAiRun(origin, cookie, 'change-review-run', 'Review a proposed file change.');
  const runId = created.body.data.run.runId;
  const listed = await fetch(`${origin}/api/v1/ai-runs/${runId}/proposed-change-set`, { headers: { Cookie: cookie } });
  const proposal = (await listed.json()).data;
  assert.equal(listed.status, 200);
  assert.equal(proposal.status, 'awaiting_approval');
  assert.equal(proposal.fakeRuntime, true);
  assert.equal(proposal.operations.length, 1);
  assert.doesNotMatch(JSON.stringify(proposal), /\/workspace|NVIDIA_API_KEY|secret-value/iu);

  const decision = await fetch(`${origin}/api/v1/ai-runs/${runId}/proposed-change-set/decision`, {
    method: 'POST',
    headers: headers(cookie, { 'Idempotency-Key': 'change-review-approve' }),
    body: JSON.stringify({ proposalHash: proposal.proposalHash, decision: 'approve' })
  });
  const result = (await decision.json()).data;
  assert.equal(decision.status, 200);
  assert.equal(result.status, 'applied');
  assert.equal(result.result.persisted, true);
  assert.equal(result.result.appliedCount, 1);
});

test('exposes a fake sandbox proposal and accepts only its persisted hash decision', async () => {
  const { origin } = await startPreview();
  const cookie = await signIn(origin);
  const created = await createAiRun(origin, cookie, 'command-run', 'Inspect the seeded project.');
  const runId = created.body.data.run.runId;
  const approveRun = await fetch(`${origin}/api/v1/ai-runs/${runId}/egress-decision`, {
    method: 'POST',
    headers: headers(cookie, { 'Idempotency-Key': 'command-run-approval' }),
    body: JSON.stringify({ manifestHash: created.body.data.manifest.manifestHash, decision: 'approve' })
  });
  assert.equal(approveRun.status, 200);

  const listed = await fetch(`${origin}/api/v1/ai-runs/${runId}/commands`, { headers: { Cookie: cookie } });
  const proposal = (await listed.json()).data.commands[0];
  assert.equal(listed.status, 200);
  assert.equal(proposal.status, 'awaiting_approval');
  assert.equal(proposal.command, 'rg');
  assert.equal(proposal.cwd, '.');
  assert.equal('args' in proposal, false);
  assert.doesNotMatch(JSON.stringify(proposal), /NVIDIA_API_KEY|\/workspace|personal-ai-app/iu);

  const decision = await fetch(`${origin}/api/v1/ai-runs/${runId}/commands/${proposal.commandId}/decision`, {
    method: 'POST',
    headers: headers(cookie, { 'Idempotency-Key': 'command-approval' }),
    body: JSON.stringify({ proposalHash: proposal.proposalHash, decision: 'approve' })
  });
  const decisionBody = await decision.json();
  assert.equal(decision.status, 200);
  assert.equal(decisionBody.data.command.status, 'completed');
  assert.match(decisionBody.data.command.result.outputPreview, /simulated sandbox output/iu);
  assert.doesNotMatch(decisionBody.data.command.result.outputPreview, /bar|mixed-value/iu);

  const replay = await fetch(`${origin}/api/v1/ai-runs/${runId}/commands/${proposal.commandId}/decision`, {
    method: 'POST',
    headers: headers(cookie, { 'Idempotency-Key': 'command-approval' }),
    body: JSON.stringify({ proposalHash: proposal.proposalHash, decision: 'approve' })
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.command.status, 'completed');
});

test('cancels a pending preview command without running it', async () => {
  const { origin } = await startPreview();
  const cookie = await signIn(origin);
  const created = await createAiRun(origin, cookie, 'command-cancel', 'Keep the command pending.');
  const runId = created.body.data.run.runId;
  await fetch(`${origin}/api/v1/ai-runs/${runId}/egress-decision`, {
    method: 'POST',
    headers: headers(cookie, { 'Idempotency-Key': 'command-cancel-run-approval' }),
    body: JSON.stringify({ manifestHash: created.body.data.manifest.manifestHash, decision: 'approve' })
  });
  const listing = await fetch(`${origin}/api/v1/ai-runs/${runId}/commands`, { headers: { Cookie: cookie } });
  const proposal = (await listing.json()).data.commands[0];
  const cancel = await fetch(`${origin}/api/v1/ai-runs/${runId}/commands/${proposal.commandId}/cancel`, {
    method: 'POST',
    headers: headers(cookie, { 'Idempotency-Key': 'command-cancel-intent' }),
    body: JSON.stringify({})
  });
  const cancelBody = await cancel.json();
  assert.equal(cancel.status, 202);
  assert.equal(cancelBody.data.command.status, 'cancelled');
  assert.equal(cancelBody.data.command.decision, 'rejected');
  assert.equal('result' in cancelBody.data.command, false);
});

test('omits unsafe paths and never echoes request secrets in the preview response', async () => {
  const { origin } = await startPreview();
  const cookie = await signIn(origin);
  const created = await createAiRun(origin, cookie, 'ai-run-safe-disclosure', 'NVIDIA_API_KEY=preview-secret', {
    relativePaths: ['/workspace/private.env', '../outside.txt', 'secrets.txt', 'src/index.ts']
  });
  const serialized = JSON.stringify(created.body);
  assert.equal(created.response.status, 202);
  assert.deepEqual(created.body.data.manifest.content.relativePaths, ['src/index.ts']);
  assert.equal(created.body.data.manifest.redaction.omittedItemCount, 3);
  assert.doesNotMatch(serialized, /NVIDIA_API_KEY|preview-secret|\/workspace|outside\.txt|secrets\.txt/iu);
});

test('reset clears fake runs and idempotency while restoring the seeded state', async () => {
  const { api, origin } = await startPreview();
  const cookie = await signIn(origin);
  const first = await createAiRun(origin, cookie, 'ai-run-reset', 'Before reset.');
  api.reset();
  const oldStatus = await fetch(`${origin}/api/v1/ai-runs/${first.body.data.run.runId}`, { headers: { Cookie: cookie } });
  assert.equal(oldStatus.status, 404);
  const second = await createAiRun(origin, cookie, 'ai-run-reset', 'After reset.');
  assert.equal(second.response.status, 202);
  assert.notEqual(second.body.data.run.runId, first.body.data.run.runId);
});

test('keeps the preview API out of normal production builds', () => {
  const production = viteConfig({ mode: 'production', command: 'build' });
  const preview = viteConfig({ mode: 'preview', command: 'serve' });
  assert.equal(production.plugins.flat(Infinity).some((plugin) => plugin?.name === 'personal-ai-workspace-preview-api'), false);
  assert.equal(preview.plugins.flat(Infinity).some((plugin) => plugin?.name === 'personal-ai-workspace-preview-api'), true);
});
