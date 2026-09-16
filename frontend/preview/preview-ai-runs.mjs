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
    if (method === 'GET' && parts[4] === 'proposed-change-set') {
      sendData(response, serializeChangeSet(run.proposedChangeSet));
      return true;
    }
    if (method === 'POST' && parts[4] === 'proposed-change-set' && parts[5] === 'decision') {
      await decideChangeSet(request, response, run);
      return true;
    }
    if (parts[4] === 'commands') {
      await handleCommands(request, response, run, parts, method);
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
    run.proposedChangeSet = createFakeChangeSet(id, projectId);
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

function createFakeChangeSet(runId, projectId) {
  const operationId = randomUUID();
  const preview = '+++ src/preview-note.md\n+Preview-only change awaiting your decision.\n';
  const proposalHash = hashValue({ runId, operationId, path: 'src/preview-note.md', content: preview });
  return {
    runId,
    projectId,
    status: 'awaiting_approval',
    decision: 'pending',
    proposalHash,
    fakeRuntime: true,
    totalSizeBytes: Buffer.byteLength(preview, 'utf8'),
    totalLineCount: 2,
    previewLimitBytes: 8192,
    previewLimitLines: 200,
    safeMessage: 'Review the proposed changes before applying them.',
    operations: [{ operationId, operation: 'create', path: 'src/preview-note.md', summary: 'Create a preview note', sourcePresent: false, destinationPresent: false, backupRequired: false, sizeBytes: Buffer.byteLength(preview, 'utf8'), lineCount: 2, reviewable: true, preview: { text: preview, limited: false, kind: 'after' } }],
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z'
  };
}

async function decideChangeSet(request, response, run) {
  const key = validIdempotencyKey(request);
  if (!key) {
    sendError(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'The mock preview requires an idempotency key.');
    return;
  }
  const body = await readBody(request);
  if (!isValidManifestHash(body?.proposalHash) || !['approve', 'reject'].includes(body?.decision)) {
    sendError(response, 400, 'VALIDATION_ERROR', 'The proposed change decision is invalid.');
    return;
  }
  const fingerprint = hashValue({ proposalHash: body.proposalHash, decision: body.decision });
  const replayKey = `change-set:${run.id}:${key}`;
  const previous = run.proposedChangeSet.decisionKeys?.get(replayKey);
  if (previous) {
    if (previous !== fingerprint) {
      sendError(response, 409, 'CHANGE_SET_IDEMPOTENCY_REUSED', 'This preview decision key was already used.');
      return;
    }
    sendData(response, serializeChangeSet(run.proposedChangeSet));
    return;
  }
  if (body.proposalHash !== run.proposedChangeSet.proposalHash || run.proposedChangeSet.decision !== 'pending') {
    sendError(response, 409, 'CHANGE_SET_CONFLICT', 'This proposed change set is stale or already decided.');
    return;
  }
  run.proposedChangeSet.decisionKeys ??= new Map();
  run.proposedChangeSet.decisionKeys.set(replayKey, fingerprint);
  if (body.decision === 'reject') {
    run.proposedChangeSet.status = 'rejected';
    run.proposedChangeSet.decision = 'rejected';
    run.proposedChangeSet.safeMessage = 'Change set rejected. No project files were changed.';
  } else {
    run.proposedChangeSet.status = 'applied';
    run.proposedChangeSet.decision = 'approved';
    run.proposedChangeSet.safeMessage = 'The preview change set was applied in the fake runtime.';
    run.proposedChangeSet.result = { persisted: true, appliedCount: 1, skippedCount: 0, failedCount: 0, backupCount: 0, operations: run.proposedChangeSet.operations.map((operation) => ({ operationId: operation.operationId, operation: operation.operation, path: operation.path, status: 'applied', backup: 'not_required', safeMessage: 'Preview change applied.' })) };
  }
  sendData(response, serializeChangeSet(run.proposedChangeSet));
}

function serializeChangeSet(changeSet) {
  const { decisionKeys, ...safe } = changeSet;
  return safe;
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
  run.commands = [createFakeCommand(run)];
}

async function handleCommands(request, response, run, parts, method) {
  const commandId = parts[5];
  if (method === 'GET' && !commandId) {
    sendData(response, { commands: (run.commands ?? []).map(serializeCommand) });
    return;
  }
  const command = (run.commands ?? []).find((candidate) => candidate.commandId === commandId);
  if (!command) {
    sendError(response, 404, 'COMMAND_NOT_FOUND', 'The sandbox command is not available in this preview run.');
    return;
  }
  if (method === 'GET' && !parts[6]) {
    sendData(response, { command: serializeCommand(command) });
    return;
  }
  if (method === 'POST' && parts[6] === 'decision') {
    await decideCommand(request, response, command);
    return;
  }
  if (method === 'POST' && parts[6] === 'cancel') {
    await cancelCommand(request, response, command);
    return;
  }
  sendError(response, 404, 'PREVIEW_NOT_FOUND', 'This sandbox command route is not part of the mock preview.');
}

async function decideCommand(request, response, command) {
  const key = validIdempotencyKey(request);
  if (!key) {
    sendError(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'The mock preview requires an idempotency key.');
    return;
  }
  const body = await readBody(request);
  if (!isValidManifestHash(body?.proposalHash) || !['approve', 'reject'].includes(body?.decision)) {
    sendError(response, 400, 'VALIDATION_ERROR', 'The sandbox command decision is invalid.');
    return;
  }
  const fingerprint = hashValue({ proposalHash: body.proposalHash, decision: body.decision });
  const previous = command.decisionKeys.get(key);
  if (previous) {
    if (previous !== fingerprint) {
      sendError(response, 409, 'IDEMPOTENCY_KEY_REUSED', 'This preview decision key was already used.');
      return;
    }
    sendData(response, { command: serializeCommand(command) });
    return;
  }
  if (body.proposalHash !== command.proposalHash) {
    sendError(response, 409, 'COMMAND_PROPOSAL_CONFLICT', 'This command proposal is no longer current.');
    return;
  }
  if (command.status !== 'awaiting_approval' || command.decision !== 'pending') {
    sendError(response, 409, 'COMMAND_DECISION_CONFLICT', 'This command already has a recorded decision.');
    return;
  }
  command.decisionKeys.set(key, fingerprint);
  if (body.decision === 'reject') {
    command.decision = 'rejected';
    command.status = 'rejected';
    command.safeMessage = 'This command was rejected and was not started.';
  } else {
    command.decision = 'approved';
    command.status = 'running';
    command.safeMessage = 'Running in the private sandbox preview.';
    completeFakeCommand(command);
  }
  sendData(response, { command: serializeCommand(command) });
}

async function cancelCommand(request, response, command) {
  const key = validIdempotencyKey(request);
  if (!key) {
    sendError(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'The mock preview requires an idempotency key.');
    return;
  }
  const body = await readBody(request);
  if (body && Object.keys(body).length > 0) {
    sendError(response, 400, 'VALIDATION_ERROR', 'The sandbox command cancellation body must be empty.');
    return;
  }
  const fingerprint = hashValue({ commandId: command.commandId, action: 'cancel' });
  const previous = command.cancelKeys.get(key);
  if (previous) {
    if (previous !== fingerprint) {
      sendError(response, 409, 'IDEMPOTENCY_KEY_REUSED', 'This preview cancellation key was already used.');
      return;
    }
    sendData(response, { command: serializeCommand(command) }, 202);
    return;
  }
  command.cancelKeys.set(key, fingerprint);
  if (command.status === 'awaiting_approval') {
    command.decision = 'rejected';
    command.status = 'cancelled';
    command.safeMessage = 'This command was cancelled before it started.';
  } else if (command.status === 'running' || command.status === 'cancel_requested') {
    command.status = 'cancel_requested';
    command.safeMessage = 'Stopping the private sandbox preview command.';
    command.status = 'cancelled';
    command.safeMessage = 'Command cancelled. No result was promoted to the project.';
  }
  sendData(response, { command: serializeCommand(command) }, 202);
}

function createFakeCommand(run) {
  const proposalHash = hashValue({ runId: run.id, command: 'rg', args: ['TODO', 'src'], cwd: '.' });
  return {
    commandId: randomUUID(),
    runId: run.id,
    proposalHash,
    command: 'rg',
    args: ['TODO', 'src'],
    cwd: '.',
    summary: 'Search the staged source tree',
    classification: 'safe',
    decision: 'pending',
    status: 'awaiting_approval',
    limits: { wallTimeMs: 10_000, idleTimeMs: 5_000, maxOutputBytes: 32_768, maxProcesses: 4, memoryBytes: 134_217_728, cpuTimeMs: 5_000, network: 'denied' },
    safeMessage: 'Review this command before it runs.',
    decisionKeys: new Map(),
    cancelKeys: new Map()
  };
}

function completeFakeCommand(command) {
  const outputPreview = 'Development preview: simulated sandbox output. foo=bar Foo = "mixed-value"';
  command.result = {
    exitCode: 0,
    termination: 'completed',
    durationMs: 1,
    outputBytes: Buffer.byteLength(outputPreview, 'utf8'),
    outputLineCount: 1,
    outputTruncated: false,
    outputSha256: hashValue(outputPreview),
    outputPreview
  };
  command.status = 'completed';
  command.safeMessage = 'Fake sandbox preview complete. No process ran on Windows or in the app container.';
}

function serializeCommand(command) {
  return {
    commandId: command.commandId,
    runId: command.runId,
    proposalHash: command.proposalHash,
    command: command.command,
    summary: command.summary,
    argumentCount: command.args.length,
    argumentSummaries: command.args.map(safeArgumentSummary),
    cwd: command.cwd,
    classification: command.classification,
    decision: command.decision,
    status: command.status,
    limits: command.limits,
    ...(command.result ? { result: safeResult(command.result, command.limits) } : {}),
    safeMessage: command.safeMessage,
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z'
  };
}

const SECRET_ASSIGNMENT_PATTERN = /((?:api[_-]?key|access[_-]?(?:key|token)(?:[_-]?id)?|refresh[_-]?token|password|passwd|secret(?:[_-]?key)?|credential|token|private[_-]?key|(?:gcp|google)[_-]?service[_-]?account(?:[_-]?key)?|service[_-]?account(?:[_-]?key)?|(?:aws|azure|nvidia)[_-]?(?:access[_-]?)?(?:key|token|secret))\s*[:=]\s*["']?)[^\s"'`,;}]+/giu;
const ENV_ASSIGNMENT_PATTERN = /((?:^|\s)[A-Z_][A-Z0-9_]*\s*=\s*["']?)[^\s"'`,;}]+/gu;
const ENV_ASSIGNMENT_TEST_PATTERN = /(?:^|\s)[A-Z_][A-Z0-9_]*\s*=/u;
const GENERIC_ENV_ASSIGNMENT_PATTERN = /((?:^|\s)[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']?)[^\s"'`,;}]+/gu;
const EMBEDDED_ABSOLUTE_PATH_TEST_PATTERN = /(?:[a-z]:[\\/]|\/{1,2})[^\s"'`,;}]+/iu;
const EMBEDDED_ABSOLUTE_PATH_PATTERN = /(?:[a-z]:[\\/]|\/{1,2})[^\s"'`,;}]+/giu;

function safeArgumentSummary(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) {
    return '[redacted]';
  }
  if (/^(?:[a-z]:[\\/]|[\\/])|\.\.(?:[\\/]|$)|(?:secret|credential|token|password|private[_-]?key)/iu.test(value) || SECRET_ASSIGNMENT_PATTERN.test(value) || ENV_ASSIGNMENT_TEST_PATTERN.test(value) || EMBEDDED_ABSOLUTE_PATH_TEST_PATTERN.test(value)) {
    SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
    return '[redacted]';
  }
  SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  return value.length > 64 ? `${value.slice(0, 61)}...` : value;
}

function safeResult(result, limits) {
  const outputPreview = typeof result.outputPreview === 'string'
    ? truncateUtf8(result.outputPreview.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(SECRET_ASSIGNMENT_PATTERN, '$1[REDACTED]').replace(GENERIC_ENV_ASSIGNMENT_PATTERN, '$1[REDACTED]').replace(EMBEDDED_ABSOLUTE_PATH_PATTERN, '[REDACTED_PATH]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ''), 4 * 1024)
    : undefined;
  SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  return {
    ...result,
    outputBytes: Math.max(0, Math.min(Number.isFinite(result.outputBytes) ? Math.floor(result.outputBytes) : 0, limits.maxOutputBytes)),
    outputTruncated: result.outputTruncated === true || result.outputBytes > limits.maxOutputBytes,
    ...(outputPreview === undefined ? {} : { outputPreview })
  };
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}
