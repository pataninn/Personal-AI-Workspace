import { randomUUID } from 'node:crypto';
import { buildManifest, hashValue, readBody, sendData, sendError, serializeSnapshot, validIdempotencyKey } from './preview-ai-run-support.mjs';

export const PREVIEW_REPLY = '## Homepage plan\n\nKeep the main message clear and the next action easy to find.\n\n| Area | Next step |\n| --- | --- |\n| Header | Review the headline |\n| Mobile | Check the layout |\n\n```ts\nconst nextStep = "Review the layout";\n```\n\nA simple example: $x^2 + y^2 = z^2$.\n\n[Read the project notes](https://example.com)\n\nThis is a deterministic preview reply; no model provider was called.';

export async function handlePreviewDirectChat({ request, response, seed, parts, method, runs, idempotency }) {
  if (parts[2] !== 'projects' || parts[4] !== 'chat-runs' || method !== 'POST') return false;
  const project = seed.projects.find((item) => item.id === parts[3]);
  const body = await readBody(request);
  const conversation = seed.conversations.find((item) => item.projectId === project?.id && item.id === body?.conversationId);
  const key = validIdempotencyKey(request);
  if (!project || !conversation) { sendError(response, 404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.'); return true; }
  if (!key || typeof body.request !== 'string' || !body.request.trim()) { sendError(response, 400, 'VALIDATION_ERROR', 'Enter a message and request key.'); return true; }
  const replayKey = `chat:${project.id}:${key}`;
  const fingerprint = hashValue(body);
  const previous = idempotency.get(replayKey);
  if (previous) {
    if (previous.fingerprint !== fingerprint) sendError(response, 409, 'IDEMPOTENCY_KEY_REUSED', 'Request key reused.');
    else sendData(response, serializeSnapshot(runs.get(previous.runId)));
    return true;
  }
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const sequence = Math.max(0, ...seed.messages.filter((item) => item.conversationId === conversation.id).map((item) => item.sequence)) + 1;
  seed.messages.push({ id: randomUUID(), conversationId: conversation.id, sequence, role: 'user', content: body.request, createdAt: timestamp },
    { id: randomUUID(), conversationId: conversation.id, sequence: sequence + 1, role: 'assistant', content: PREVIEW_REPLY, createdAt: timestamp });
  conversation.updatedAt = timestamp; conversation.lastActivityAt = timestamp;
  const run = { id, projectId: project.id, conversationId: conversation.id, status: 'succeeded', phase: 'terminal', decision: 'approved',
    cleanup: 'complete', providerTransmission: 'not_started_confirmed', stagingItemCount: 0, safeMessage: 'Preview reply complete. No model provider was called.',
    manifest: buildManifest(id, body.request, { relativePaths: [], includeRecentMessages: false }, conversation, []) };
  runs.set(id, run); idempotency.set(replayKey, { runId: id, fingerprint });
  seed.taskSuggestions.push({ id: randomUUID(), projectId: project.id, runId: id, conversationId: conversation.id, title: 'Review the homepage plan',
    details: 'Review the preview layout changes.', subtasks: [{ title: 'Review desktop' }, { title: 'Review mobile' }], status: 'pending', version: 1,
    taskId: null, source: { kind: 'assistant', label: 'Suggested by the assistant' }, createdAt: timestamp, resolvedAt: null });
  sendData(response, serializeSnapshot(run));
  return true;
}
