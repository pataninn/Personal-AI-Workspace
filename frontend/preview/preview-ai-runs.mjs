import { randomUUID } from 'node:crypto';

import {
  buildManifest,
  findProject,
  hashValue,
  isValidManifestHash,
  readBody,
  sendData,
  sendError,
  serializeManifest,
  serializeSnapshot,
  validIdempotencyKey,
  validateCreateBody
} from './preview-ai-run-support.mjs';

function isCreateRoute(parts) {
  return parts[2] === 'projects' && parts[4] === 'ai-runs';
}

function isRunRoute(parts) {
  return parts[2] === 'ai-runs';
}

export function createPreviewAiRuns() {
  let runs = new Map();
  let idempotency = new Map();

  function reset() {
    runs = new Map();
    idempotency = new Map();
  }

  async function handle(request, response, seed, parts, method) {
    if (isCreateRoute(parts)) {
      if (method !== 'POST') {
        sendError(response, 404, 'PREVIEW_NOT_FOUND', 'This AI run route is not part of the mock preview.');
        return true;
      }
      await createRun(request, response, seed, parts[3]);
      return true;
    }
    if (!isRunRoute(parts)) {
      return false;
    }
    const run = runs.get(parts[3]);
    if (!run) {
      sendError(response, 404, 'AI_RUN_NOT_FOUND', 'This AI run is not available in the mock preview.');
      return true;
    }
    if (method === 'GET' && !parts[4]) {
      sendData(response, serializeSnapshot(run));
      return true;
    }
    if (method === 'GET' && parts[4] === 'egress-manifest') {
      sendData(response, serializeManifest(run));
      return true;
    }
    if (method === 'POST' && parts[4] === 'egress-decision') {
      await decideRun(request, response, run);
      return true;
    }
    sendError(response, 404, 'PREVIEW_NOT_FOUND', 'This AI run route is not part of the mock preview.');
    return true;
  }

  async function createRun(request, response, seed, projectId) {
    const project = findProject(seed, projectId);
    if (!project) {
      sendError(response, 404, 'PROJECT_NOT_FOUND', 'Project not found in the mock preview.');
      return;
    }
    if (project.status === 'archived') {
      sendError(response, 409, 'PROJECT_ARCHIVED', 'This preview project is archived.');
      return;
    }
    const key = validIdempotencyKey(request);
    if (!key) {
      sendError(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'The mock preview requires an idempotency key.');
      return;
    }
    const body = await readBody(request);
    const validated = validateCreateBody(body, seed, projectId);
    if (validated.error) {
      sendError(response, 400, 'VALIDATION_ERROR', validated.error);
      return;
    }
    const fingerprint = hashValue({ projectId, conversationId: body.conversationId, request: validated.request, context: validated.context });
    const replayKey = `create:${projectId}:${key}`;
    const previous = idempotency.get(replayKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        sendError(response, 409, 'IDEMPOTENCY_KEY_REUSED', 'This preview request key was already used.');
        return;
      }
      const replayRun = runs.get(previous.runId);
      sendData(response, { run: serializeSnapshot(replayRun), manifest: serializeManifest(replayRun) }, 200);
      return;
    }
    const id = randomUUID();
    const manifest = buildManifest(id, validated.request, validated.context, validated.conversation, seed.messages);
    const run = {
      id,
      projectId,
      conversationId: validated.conversation.id,
      manifest,
      status: 'pending_approval',
      phase: 'manifest',
      decision: 'pending',
      safeMessage: 'Review the provider disclosure before continuing.',
      cleanup: 'not_started',
      providerTransmission: 'not_started_confirmed',
      stagingItemCount: 0
    };
    runs.set(id, run);
    idempotency.set(replayKey, { fingerprint, runId: id });
    sendData(response, { run: serializeSnapshot(run), manifest: serializeManifest(run) }, 202, { Location: `/api/v1/ai-runs/${id}` });
  }

  async function decideRun(request, response, run) {
    const key = validIdempotencyKey(request);
    if (!key) {
      sendError(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'The mock preview requires an idempotency key.');
      return;
    }
    const body = await readBody(request);
    const decision = body?.decision;
    const manifestHash = body?.manifestHash;
    if (!isValidManifestHash(manifestHash) || !['approve', 'reject'].includes(decision)) {
      sendError(response, 400, 'VALIDATION_ERROR', 'The AI run decision is invalid.');
      return;
    }
    const fingerprint = hashValue({ manifestHash, decision });
    const replayKey = `decision:${run.id}:${key}`;
    const previous = idempotency.get(replayKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        sendError(response, 409, 'IDEMPOTENCY_KEY_REUSED', 'This preview decision key was already used.');
        return;
      }
      sendData(response, { run: serializeSnapshot(run), manifest: serializeManifest(run) });
      return;
    }
    if (manifestHash !== run.manifest.manifestHash) {
      sendError(response, 409, 'EGRESS_MANIFEST_CONFLICT', 'This disclosure is no longer current. Review the updated scope before approving.');
      return;
    }
    if (run.decision !== 'pending') {
      sendError(response, 409, 'EGRESS_DECISION_CONFLICT', 'This AI run already has a recorded decision.');
      return;
    }
    applyDecision(run, decision);
    idempotency.set(replayKey, { fingerprint, runId: run.id });
    sendData(response, { run: serializeSnapshot(run), manifest: serializeManifest(run) });
  }

  return { handle, reset };
}

function applyDecision(run, decision) {
  if (decision === 'reject') {
    run.status = 'rejected';
    run.phase = 'decision';
    run.decision = 'rejected';
    run.safeMessage = 'This run was not started. No project content was staged or sent to NVIDIA.';
    return;
  }
  run.status = 'ready';
  run.phase = 'runtime';
  run.decision = 'approved';
  run.stagingItemCount = run.manifest.itemCount;
  run.runtime = { kind: 'fake', sandboxReady: true };
  run.safeMessage = 'Private run environment ready. Your approved context is isolated for this run. The assistant can now begin working.';
}
