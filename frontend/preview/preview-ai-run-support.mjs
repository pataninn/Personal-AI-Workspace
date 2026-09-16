import { createHash } from 'node:crypto';

export const PROVIDER = 'NVIDIA hosted NIM';
export const PROVIDER_PROFILE = 'nvidia-hosted-nim';
export const MODEL = 'nvidia/nemotron-3-super-120b-a12b';
export const PRE_CONSENT_NOTICE = 'Nothing has been copied to the run staging area or sent to NVIDIA yet.';
export const REJECTED_NOTICE = 'Nothing was copied to the run staging area or sent to NVIDIA.';
export const APPROVED_NOTICE = 'This disclosure was approved for this run.';
export const REQUEST_ONLY_NOTICE = 'No project files or facts are selected. Only your request will be sent if you approve.';
const MAX_REQUEST_BYTES = 8_000;
const MAX_PATHS = 100;

export function sendData(response, data, status = 200, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify({ data, error: null }));
}

export function sendError(response, status, code, message) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ data: null, error: { code, message } }));
}

export async function readBody(request) {
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

export function findProject(seed, projectId) {
  return seed.projects.find((project) => project.id === projectId);
}

export function findConversation(seed, conversationId, projectId) {
  return seed.conversations.find((conversation) => conversation.id === conversationId && conversation.projectId === projectId);
}

export function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function validIdempotencyKey(request) {
  const key = request.headers['idempotency-key'];
  return typeof key === 'string' && /^[\x20-\x7e]{8,200}$/u.test(key) ? key : null;
}

export function isValidManifestHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeRelativePath(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!path || /[\u0000-\u001f\u007f]/u.test(path) || path.startsWith('/') || /^[a-z]:/iu.test(path)) {
    return null;
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return null;
  }
  if (segments.some((segment) => /(?:\.env(?:\..*)?|secrets?|credentials?|tokens?|id_rsa|\.(?:pem|key))/iu.test(segment))) {
    return null;
  }
  return path;
}

export function buildManifest(runId, request, context, conversation, messages) {
  const candidates = Array.isArray(context.relativePaths) ? context.relativePaths : [];
  const paths = [];
  let omittedItemCount = Math.max(0, candidates.length - MAX_PATHS);
  for (const candidate of candidates.slice(0, MAX_PATHS)) {
    const path = safeRelativePath(candidate);
    if (!path || paths.includes(path)) {
      omittedItemCount += 1;
      continue;
    }
    paths.push(path);
  }
  const recentMessages = context.includeRecentMessages ? messages.filter((message) => message.conversationId === conversation.id) : [];
  const categories = ['Request'];
  if (recentMessages.length > 0) {
    categories.push('Recent conversation');
  }
  if (paths.length > 0) {
    categories.push('Project files');
  }
  const byteEstimate = Buffer.byteLength(request, 'utf8')
    + paths.reduce((total, path) => total + Buffer.byteLength(path, 'utf8'), 0)
    + recentMessages.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8'), 0);
  const unsigned = { runId, provider: PROVIDER, providerProfile: PROVIDER_PROFILE, model: MODEL, categories, paths, recentMessageCount: recentMessages.length, byteEstimate, omittedItemCount };
  return {
    runId,
    manifestHash: hashValue(unsigned),
    provider: PROVIDER,
    providerProfile: PROVIDER_PROFILE,
    model: MODEL,
    categories,
    relativePaths: paths,
    itemCount: paths.length + recentMessages.length,
    byteEstimate,
    tokenEstimate: Math.max(1, Math.ceil(byteEstimate / 4)),
    excludedItemCount: 0,
    omittedItemCount,
    omissionSummary: omittedItemCount > 0 ? 'Some items were excluded by local safety policy.' : 'No selected items were excluded.',
    bestEffortSecretDetection: true,
    emptyContext: paths.length === 0 && recentMessages.length === 0
  };
}

export function serializeSnapshot(run) {
  return {
    runId: run.id,
    projectId: run.projectId,
    conversationId: run.conversationId,
    status: run.status,
    phase: run.phase,
    manifestHash: run.manifest.manifestHash,
    decision: run.decision,
    safeMessage: run.safeMessage,
    cleanup: run.cleanup,
    providerTransmission: run.providerTransmission,
    stagingItemCount: run.stagingItemCount,
    ...(run.runtime ? { runtime: { kind: 'fake', sandboxReady: true } } : {})
  };
}

export function serializeManifest(run) {
  const preConsentNotice = run.decision === 'pending'
    ? PRE_CONSENT_NOTICE
    : run.decision === 'rejected' ? REJECTED_NOTICE : APPROVED_NOTICE;
  return {
    runId: run.id,
    manifestHash: run.manifest.manifestHash,
    status: run.decision === 'pending' ? 'pending_approval' : run.status,
    provider: run.manifest.provider,
    providerProfile: run.manifest.providerProfile,
    model: run.manifest.model,
    content: {
      categories: run.manifest.categories,
      relativePaths: run.manifest.relativePaths,
      itemCount: run.manifest.itemCount,
      byteEstimate: run.manifest.byteEstimate,
      tokenEstimate: run.manifest.tokenEstimate,
      messageCount: run.manifest.categories.includes('Recent conversation') ? run.manifest.itemCount - run.manifest.relativePaths.length : 0
    },
    redaction: {
      excludedItemCount: run.manifest.excludedItemCount,
      omittedItemCount: run.manifest.omittedItemCount,
      summary: run.manifest.omissionSummary
    },
    bestEffortSecretDetection: run.manifest.bestEffortSecretDetection,
    preConsentNotice,
    ...(run.manifest.emptyContext ? { emptyContextNotice: REQUEST_ONLY_NOTICE } : {})
  };
}

export function validateCreateBody(body, seed, projectId) {
  if (!isRecord(body) || typeof body.conversationId !== 'string' || typeof body.request !== 'string') {
    return { error: 'The AI run request is invalid.' };
  }
  const request = body.request.trim();
  if (!request || Buffer.byteLength(request, 'utf8') > MAX_REQUEST_BYTES) {
    return { error: 'Enter a non-empty request within the preview limit.' };
  }
  const conversation = findConversation(seed, body.conversationId, projectId);
  if (!conversation) {
    return { error: 'Conversation not found in this preview project.' };
  }
  const context = body.context ?? {};
  if (!isRecord(context) || (context.relativePaths !== undefined && !Array.isArray(context.relativePaths)) || (context.includeRecentMessages !== undefined && typeof context.includeRecentMessages !== 'boolean')) {
    return { error: 'The AI run context is invalid.' };
  }
  return { request, context: { relativePaths: context.relativePaths ?? [], includeRecentMessages: context.includeRecentMessages ?? false }, conversation };
}
