import { ApiClientError, deleteNoContent, getJson, postJson } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import type {
  AiRunIntent,
  AiRunPhase,
  AiRunSnapshot,
  AiRunStatus,
  AiRunTaskSuggestion,
  CleanupStatus,
  EgressDecision,
  EgressFactDisclosure,
  EgressManifest,
  ProviderPermission,
  ProviderTransmissionStatus
} from '@/entities/ai-run/model/types';

const PROJECTS_PATH = '/api/v1/projects';
const RUNS_PATH = '/api/v1/ai-runs';
const DEFAULT_PROVIDER = 'NVIDIA hosted NIM';
const DEFAULT_PROVIDER_PROFILE = 'nvidia-hosted-nim';
const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const PRE_CONSENT_NOTICE = 'Nothing has been sent to the model provider yet.';
const REQUEST_ONLY_NOTICE = 'No project files or facts are selected. Only your request will be sent if you approve.';
const SAFE_CATEGORIES = new Set(['Request', 'Recent conversation', 'Project files', 'Project facts', 'Selected relative paths']);

export interface CreateAiRunRequest {
  readonly conversationId: string;
  readonly request: string;
  readonly context: {
    readonly relativePaths: readonly string[];
    readonly includeRecentMessages: boolean;
    readonly factIds?: readonly string[];
  };
}

export interface EgressDecisionRequest {
  readonly manifestHash: string;
  readonly decision: 'approve' | 'reject';
  readonly rememberProviderPermission?: boolean;
}

export function listProviderPermissions(projectId: string): Promise<readonly ProviderPermission[]> {
  return getJson<unknown>(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}/provider-permissions`).then(normalizeProviderPermissions);
}

export function revokeProviderPermission(projectId: string, permissionId: string, csrfToken: string): Promise<void> {
  return deleteNoContent(
    `${PROJECTS_PATH}/${encodeURIComponent(projectId)}/provider-permissions/${encodeURIComponent(permissionId)}`,
    { 'X-CSRF-Token': csrfToken }
  );
}

export function createAiRun(
  projectId: string,
  request: CreateAiRunRequest,
  csrfToken: string,
  idempotencyKey: string = createIdempotencyKey()
): Promise<AiRunIntent> {
  return postJson<unknown>(
    `${PROJECTS_PATH}/${encodeURIComponent(projectId)}/ai-runs`,
    request,
    { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }
  ).then((value) => normalizeAiRunIntent(value));
}

export function getAiRun(runId: string): Promise<AiRunSnapshot> {
  return getJson<unknown>(`${RUNS_PATH}/${encodeURIComponent(runId)}`).then((value) => normalizeAiRunSnapshot(value));
}

export function sendChatMessage(projectId: string, conversationId: string, request: string, csrfToken: string, idempotencyKey: string): Promise<AiRunIntent> {
  return postJson<unknown>(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}/chat-runs`, { conversationId, request },
    { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }).then(normalizeAiRunIntent);
}

export function startAiRun(
  runId: string,
  csrfToken: string,
  idempotencyKey: string = createIdempotencyKey()
): Promise<AiRunSnapshot> {
  return postJson<unknown>(
    `${RUNS_PATH}/${encodeURIComponent(runId)}/start`,
    {},
    { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }
  ).then((value) => normalizeAiRunSnapshot(value));
}

export function cancelAiRun(
  runId: string,
  csrfToken: string,
  idempotencyKey: string = createIdempotencyKey()
): Promise<AiRunSnapshot> {
  return postJson<unknown>(
    `${RUNS_PATH}/${encodeURIComponent(runId)}/cancel`,
    {},
    { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }
  ).then((value) => normalizeAiRunSnapshot(value));
}

export function aiRunEventsUrl(runId: string): string {
  return `${RUNS_PATH}/${encodeURIComponent(runId)}/events`;
}

export function getEgressManifest(runId: string): Promise<EgressManifest> {
  return getJson<unknown>(`${RUNS_PATH}/${encodeURIComponent(runId)}/egress-manifest`).then((value) => normalizeEgressManifest(value, runId));
}

export function decideEgress(
  runId: string,
  request: EgressDecisionRequest,
  csrfToken: string,
  idempotencyKey: string = createIdempotencyKey()
): Promise<AiRunSnapshot> {
  return postJson<unknown>(
    `${RUNS_PATH}/${encodeURIComponent(runId)}/egress-decision`,
    request,
    { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }
  ).then((value) => normalizeAiRunSnapshot(value));
}

export function normalizeAiRunIntent(value: unknown): AiRunIntent {
  const record = asRecord(value) ?? {};
  const resource = asRecord(record.run) ?? record;
  const snapshot = normalizeAiRunSnapshot(resource);
  const manifestSource = record.manifest ?? resource.manifest;
  return {
    ...snapshot,
    ...(manifestSource !== undefined ? { manifest: normalizeEgressManifest(manifestSource, snapshot.runId, snapshot.manifestHash) } : {})
  };
}

export function normalizeAiRunSnapshot(value: unknown): AiRunSnapshot {
  const envelope = asRecord(value) ?? {};
  const record = asRecord(envelope.run) ?? envelope;
  const runId = readString(record, 'runId') ?? readString(record, 'id');
  const projectId = readString(record, 'projectId');
  const conversationId = readString(record, 'conversationId');
  const status = readStatus(record.status);
  const phase = readPhase(record.phase);
  const manifest = asRecord(record.manifest);
  const manifestHash = readHash(record.manifestHash) ?? (manifest ? readHash(manifest.manifestHash) : undefined);
  const decision = readDecision(record.decision);
  if (!runId || !projectId || !conversationId || !status || !phase || !manifestHash || !decision) {
    throw invalidResponse();
  }
  const runtime = normalizeRuntime(record.runtime, record.runtimeKind, record.sandboxReady);
  const assistant = normalizeAssistant(record.assistant);
  const taskSuggestions = normalizeRunTaskSuggestions(record.taskSuggestions, runId, projectId, conversationId);
  return {
    runId,
    projectId,
    conversationId,
    status,
    phase,
    manifestHash,
    decision,
    ...(record.providerApprovalMode === 'remembered_permission' || record.providerApprovalMode === 'one_time' ? { providerApprovalMode: record.providerApprovalMode } : {}),
    safeMessage: readSafeMessage(readString(record.safeMessage)),
    cleanup: readCleanup(record.cleanup),
    providerTransmission: readProviderTransmission(record.providerTransmission),
    stagingItemCount: readNonNegativeNumber(record.stagingItemCount),
    ...(runtime ? { runtime } : {}),
    ...(assistant ? { assistant } : {}),
    ...(taskSuggestions ? { taskSuggestions } : {})
  };
}

export function normalizeProviderPermissions(value: unknown): readonly ProviderPermission[] {
  const envelope = asRecord(value) ?? {};
  const entries = envelope.permissions;
  if (!Array.isArray(entries)) throw invalidResponse();
  return entries.map((entry): ProviderPermission => {
    const record = asRecord(entry);
    const subject = asRecord(record?.subject);
    if (!record || !subject || record.capability !== 'send_selected_context' || record.persistence !== 'until_revoked'
      || record.expiresAt !== null || record.revokedAt !== null && typeof record.revokedAt !== 'string') {
      throw invalidResponse();
    }
    return {
      id: requireString(record.id),
      ownerId: requireString(subject.ownerId),
      projectId: requireString(record.projectId),
      providerProfile: requireString(record.providerProfile),
      model: requireString(record.model),
      capability: 'send_selected_context',
      persistence: 'until_revoked',
      expiresAt: null,
      createdAt: requireString(record.createdAt),
      revokedAt: record.revokedAt
    };
  });
}

function normalizeRunTaskSuggestions(value: unknown, runId: string, projectId: string, conversationId: string): readonly AiRunTaskSuggestion[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 5) {
    throw invalidResponse();
  }
  return value.map((entry: unknown) => {
    const suggestion = asRecord(entry);
    const source = asRecord(suggestion?.source);
    const title = readString(suggestion?.title);
    const details = suggestion?.details;
    const status = suggestion?.status;
    const version = suggestion?.version;
    const taskId = suggestion?.taskId;
    const createdAt = readString(suggestion?.createdAt);
    const resolvedAt = suggestion?.resolvedAt;
    if (!suggestion || !source || suggestion.runId !== runId || suggestion.projectId !== projectId || suggestion.conversationId !== conversationId
      || source.kind !== 'assistant' || source.label !== 'Suggested by the assistant'
      || !title || Array.from(title).length > 120 || /[\u0000-\u001f\u007f]/u.test(title)
      || (details !== null && (typeof details !== 'string' || new TextEncoder().encode(details).length > 4096))
      || (status !== 'pending' && status !== 'accepted' && status !== 'dismissed')
      || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1
      || (taskId !== null && typeof taskId !== 'string')
      || !createdAt || !Number.isFinite(Date.parse(createdAt))
      || (resolvedAt !== null && (typeof resolvedAt !== 'string' || !Number.isFinite(Date.parse(resolvedAt))))) {
      throw invalidResponse();
    }
    return {
      id: requireString(suggestion.id),
      projectId,
      runId,
      conversationId,
      title,
      details,
      status,
      version,
      taskId,
      source: { kind: 'assistant', label: 'Suggested by the assistant' },
      createdAt,
      resolvedAt
    };
  });
}

export function normalizeEgressManifest(value: unknown, runId: string, fallbackManifestHash?: string): EgressManifest {
  const record = asRecord(value) ?? {};
  const source = asRecord(record.manifest) ?? record;
  const status = source.status === undefined ? 'pending_approval' : readStatus(source.status);
  const content = asRecord(source.content);
  const redaction = asRecord(source.redaction);
  const manifestHash = readHash(source.manifestHash) ?? (fallbackManifestHash && readHash(fallbackManifestHash));
  if (!manifestHash || !status) {
    throw invalidResponse();
  }

  const rawPaths = content?.relativePaths ?? source.relativePaths;
  const filePaths = source.files;
  const relativePaths = normalizeRelativePaths(rawPaths, filePaths);
  const rawCategories = content?.categories ?? source.categories;
  const messageCount = readNonNegativeNumber(content?.messageCount ?? source.messageCount);
  const facts = normalizeFactDisclosures(content?.facts);
  const categories = normalizeCategories(rawCategories, relativePaths.length > 0, messageCount > 0, facts.length > 0);
  const excludedItemCount = readNonNegativeNumber(redaction?.excludedItemCount ?? source.excludedItemCount);
  const omittedItemCount = readNonNegativeNumber(redaction?.omittedItemCount ?? source.omittedItemCount);
  const itemCount = Math.max(readNonNegativeNumber(content?.itemCount ?? source.itemCount, relativePaths.length), relativePaths.length);
  const byteEstimate = readNonNegativeNumber(content?.byteEstimate ?? source.byteEstimate);
  const tokenEstimate = readNonNegativeNumber(content?.tokenEstimate ?? source.tokenEstimate);
  const providerProfile = readSafeLabel(source.providerProfile, DEFAULT_PROVIDER_PROFILE);
  const provider = readSafeLabel(source.provider, providerProfile === 'nebius-token-factory' ? 'Nebius Token Factory' : DEFAULT_PROVIDER);
  const model = readSafeModel(source.model);
  const omissionSummary = readOmissionSummary(
    redaction?.summary ?? source.omissionSummary,
    excludedItemCount + omittedItemCount > 0
  );

  return {
    runId,
    manifestHash,
    status,
    provider,
    providerProfile,
    model,
    categories,
    relativePaths,
    itemCount,
    messageCount,
    facts,
    byteEstimate,
    tokenEstimate,
    excludedItemCount,
    omittedItemCount,
    omissionSummary,
    bestEffortSecretDetection: readBoolean(source.bestEffortSecretDetection, true),
    preConsentNotice: `Nothing has been sent to ${provider} yet.`
  };
}

function normalizeFactDisclosures(value: unknown): readonly EgressFactDisclosure[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidResponse();
  }
  return value.map((entry) => normalizeFactDisclosure(entry));
}

function normalizeFactDisclosure(value: unknown): EgressFactDisclosure {
  const record = asRecord(value);
  const source = asRecord(record?.source);
  const kind = source?.kind;
  const reference = source?.reference;
  const verificationStatus = record?.verificationStatus;
  const verifiedAt = record?.verifiedAt;
  const version = record?.version;
  const sizeBytes = record?.sizeBytes;
  const sourceHash = readHash(record?.sourceHash);
  if (!record || !source || (kind !== 'user' && kind !== 'conversation' && kind !== 'project_file')
    || typeof reference !== 'string' && reference !== null
    || verificationStatus !== 'verified' && verificationStatus !== 'needs_review'
    || verifiedAt !== null && typeof verifiedAt !== 'string'
    || (verificationStatus === 'verified') !== (verifiedAt !== null)
    || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1
    || typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0
    || !sourceHash) {
    throw invalidResponse();
  }
  return {
    id: requireString(record.id),
    title: requireString(record.title),
    content: requireString(record.content),
    source: { kind, label: requireString(source.label), reference },
    version,
    verifiedAt,
    verificationStatus,
    sizeBytes,
    sourceHash
  };
}

function requireString(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw invalidResponse();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown, key?: string): string | undefined {
  const candidate = key === undefined ? value : asRecord(value)?.[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function readSafeMessage(value: string | undefined): string {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return '';
  }
  return value;
}

function readSafeLabel(value: unknown, fallback: string): string {
  const candidate = readString(value);
  if (!candidate || candidate.length > 160 || /[\r\n]/u.test(candidate)) {
    return fallback;
  }
  return candidate;
}

function readSafeModel(value: unknown): string {
  const candidate = readSafeLabel(value, DEFAULT_MODEL);
  return /^https?:\/\//iu.test(candidate) || candidate.includes('NVIDIA_API_KEY') ? DEFAULT_MODEL : candidate;
}

function readHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

function readNonNegativeNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function normalizeRelativePaths(rawPaths: unknown, rawFiles: unknown): readonly string[] {
  const candidates: unknown[] = [];
  if (Array.isArray(rawPaths)) {
    candidates.push(...rawPaths);
  }
  if (Array.isArray(rawFiles)) {
    candidates.push(...rawFiles.map((entry) => asRecord(entry)?.relativePath));
  }
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const path = safeRelativePath(candidate);
    if (path && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

function safeRelativePath(value: string): string | null {
  const trimmed = value.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!trimmed || /[\u0000-\u001f\u007f]/u.test(trimmed) || trimmed.startsWith('/') || /^[a-z]:/iu.test(trimmed) || trimmed.split('/').some((part) => part === '..')) {
    return null;
  }
  return trimmed;
}

function readOmissionSummary(value: unknown, hasOmissions: boolean): string {
  const candidate = readString(value);
  const safeSummaries = new Set([
    'No selected items were excluded.',
    'No selected items were excluded or omitted.',
    'Some items were excluded by local safety policy.',
    'Some selected items were excluded by local safety policy.',
    'Some selected items were omitted by bounded inspection or size policy.',
    'Some selected items were excluded by local safety policy or omitted by bounded inspection.'
  ]);
  if (candidate && safeSummaries.has(candidate)) {
    return candidate;
  }
  return hasOmissions ? 'Some selected items were excluded by local safety policy.' : 'No selected items were excluded.';
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeCategories(value: unknown, hasFiles: boolean, hasMessages: boolean, hasFacts: boolean): readonly string[] {
  const categories = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && SAFE_CATEGORIES.has(entry))
    : [];
  const result = categories.length > 0 ? [...new Set(categories)] : ['Request'];
  if (hasFiles && !result.includes('Project files')) {
    result.push('Project files');
  }
  if (hasMessages && !result.includes('Recent conversation')) {
    result.push('Recent conversation');
  }
  if (hasFacts && !result.includes('Project facts')) {
    result.push('Project facts');
  }
  if (!hasFiles && result.includes('Project files')) {
    return removeUnavailableCategories(result, false, hasMessages, hasFacts);
  }
  return removeUnavailableCategories(result, hasFiles, hasMessages, hasFacts);
}

function removeUnavailableCategories(categories: readonly string[], hasFiles: boolean, hasMessages: boolean, hasFacts: boolean): readonly string[] {
  return categories.filter((category) => category !== 'Project files' || hasFiles)
    .filter((category) => category !== 'Recent conversation' || hasMessages)
    .filter((category) => category !== 'Project facts' || hasFacts);
}

function readStatus(value: unknown): AiRunStatus | undefined {
  return value === 'pending_approval' || value === 'rejected' || value === 'staging' || value === 'ready' || value === 'queued' || value === 'running' || value === 'waiting_approval' || value === 'succeeded' || value === 'failed' || value === 'cancel_requested' || value === 'cancelled' || value === 'blocked' || value === 'review_required' ? value : undefined;
}

function readPhase(value: unknown): AiRunPhase | undefined {
  return value === 'manifest' || value === 'decision' || value === 'staging' || value === 'runtime' || value === 'inference' || value === 'terminal' || value === 'review' ? value : undefined;
}

function readDecision(value: unknown): EgressDecision | undefined {
  return value === 'pending' || value === 'approved' || value === 'rejected' ? value : undefined;
}

function readCleanup(value: unknown): CleanupStatus {
  return value === 'complete' || value === 'unknown' ? value : 'not_started';
}

function readProviderTransmission(value: unknown): ProviderTransmissionStatus {
  return value === 'not_started_confirmed' || value === 'transmitted_confirmed' || value === 'unknown' ? value : 'not_started';
}

function normalizeRuntime(value: unknown, runtimeKind: unknown, sandboxReady: unknown): AiRunSnapshot['runtime'] | undefined {
  const record = asRecord(value);
  const kind = record?.kind ?? runtimeKind;
  const ready = record?.sandboxReady ?? sandboxReady;
  return (kind === 'fake' || kind === 'direct' || kind === 'hermes') && ready === true ? { kind, sandboxReady: true } : undefined;
}

function normalizeAssistant(value: unknown): AiRunSnapshot['assistant'] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const contentLength = readNonNegativeNumber(record.contentLength);
  const complete = record.complete === true;
  const messageId = readString(record.messageId);
  return { ...(messageId ? { messageId } : {}), complete, contentLength };
}

function invalidResponse(): ApiClientError {
  return new ApiClientError(200, 'INVALID_RESPONSE', 'The local app returned an invalid AI run response.');
}

export { DEFAULT_MODEL, DEFAULT_PROVIDER, PRE_CONSENT_NOTICE, REQUEST_ONLY_NOTICE };
