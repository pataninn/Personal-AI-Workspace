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
  assert.deepEqual(production.plugins, []);
  assert.equal(preview.plugins.some((plugin) => plugin.name === 'personal-ai-workspace-preview-api'), true);
});
