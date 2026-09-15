import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, test } from 'node:test';

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
  return `http://127.0.0.1:${server.address().port}`;
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

test('requires a mock session and allows login with made-up input', async () => {
  const origin = await startPreview();
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
  const origin = await startPreview();
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

test('supports seeded history, new conversations, and idempotent message retries', async () => {
  const origin = await startPreview();
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
  const origin = await startPreview();
  const cookie = await signIn(origin);
  const response = await fetch(`${origin}/api/v1/runs`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'PREVIEW_NOT_FOUND');
});
