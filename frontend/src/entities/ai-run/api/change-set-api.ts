import { ApiClientError, getJson, postJson } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import type {
  ProposedChangeBackupStatus,
  ProposedChangeDecision,
  ProposedChangeOperation,
  ProposedChangeOperationKind,
  ProposedChangeOperationResult,
  ProposedChangeOperationStatus,
  ProposedChangePreview,
  ProposedChangeSetResult,
  ProposedChangeSetSnapshot,
  ProposedChangeSetStatus
} from '@/entities/ai-run/model/types';

const RUNS_PATH = '/api/v1/ai-runs';
const MAX_PATH_LENGTH = 2048;
const MAX_PREVIEW_BYTES = 8 * 1024;
const MAX_PREVIEW_LINES = 200;
const OPERATION_KINDS = new Set<ProposedChangeOperationKind>(['create', 'edit', 'overwrite', 'rename', 'delete']);
const SET_STATUSES = new Set<ProposedChangeSetStatus>(['awaiting_approval', 'applying', 'applied', 'rejected', 'stale', 'blocked', 'failed', 'needs_manual_review']);
const DECISIONS = new Set<ProposedChangeDecision>(['pending', 'approved', 'rejected', 'policy_authorized']);

export function getProposedChangeSet(runId: string): Promise<ProposedChangeSetSnapshot> {
  return getJson<unknown>(`${RUNS_PATH}/${encodeURIComponent(runId)}/proposed-change-set`).then(normalizeProposedChangeSet);
}

export function decideProposedChangeSet(
  runId: string,
  proposalHash: string,
  decision: 'approve' | 'reject',
  csrfToken: string,
  idempotencyKey: string = createIdempotencyKey()
): Promise<ProposedChangeSetSnapshot> {
  return postJson<unknown>(
    `${RUNS_PATH}/${encodeURIComponent(runId)}/proposed-change-set/decision`,
    { proposalHash, decision },
    { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }
  ).then(normalizeProposedChangeSet);
}

export function normalizeProposedChangeSet(value: unknown): ProposedChangeSetSnapshot {
  const source = asRecord(value);
  const record = asRecord(source?.data) ?? source;
  if (!record) {
    throw invalidResponse();
  }
  const runId = readString(record.runId);
  const projectId = readString(record.projectId);
  const status = readSetStatus(record.status);
  const decision = readDecision(record.decision);
  const proposalHash = readHash(record.proposalHash);
  if (!runId || !projectId || !status || !decision || !proposalHash) {
    throw invalidResponse();
  }
  const operations = Array.isArray(record.operations)
    ? record.operations.map(normalizeOperation).filter((operation): operation is ProposedChangeOperation => operation !== null)
    : [];
  if (operations.length !== (Array.isArray(record.operations) ? record.operations.length : 0)) {
    throw invalidResponse();
  }
  const counts = normalizeCounts(record.counts, operations);
  const runtimeProvenance = record.runtimeProvenance === 'fake_runtime_development_preview' || record.runtimeProvenance === 'unverified_runtime'
    ? record.runtimeProvenance
    : record.fakeRuntime === true ? 'fake_runtime_development_preview' : 'unverified_runtime';
  const result = record.result === undefined ? undefined : normalizeResult(record.result);
  if (record.result !== undefined && !result) {
    throw invalidResponse();
  }
  const createdAt = readIsoDate(record.createdAt);
  const updatedAt = readIsoDate(record.updatedAt);
  if (!createdAt || !updatedAt) {
    throw invalidResponse();
  }
  return {
    runId,
    projectId,
    status,
    decision,
    proposalHash,
    fakeRuntime: record.fakeRuntime === true,
    runtimeProvenance,
    counts,
    totalSizeBytes: readBoundedNumber(record.totalSizeBytes),
    totalLineCount: readBoundedNumber(record.totalLineCount),
    previewLimitBytes: Math.min(readBoundedNumber(record.previewLimitBytes, MAX_PREVIEW_BYTES), MAX_PREVIEW_BYTES),
    previewLimitLines: Math.min(readBoundedNumber(record.previewLimitLines, MAX_PREVIEW_LINES), MAX_PREVIEW_LINES),
    safeMessage: readSafeText(record.safeMessage, 500),
    operations,
    ...(result ? { result } : {}),
    createdAt,
    updatedAt
  };
}

function normalizeOperation(value: unknown): ProposedChangeOperation | null {
  const record = asRecord(value);
  const operationId = readString(record?.operationId);
  const operation = readOperation(record?.operation);
  const path = safeRelativePath(record?.path);
  const destinationPath = record?.destinationPath === undefined ? undefined : safeRelativePath(record.destinationPath);
  if (!record || !operationId || !operation || !path || (record.destinationPath !== undefined && !destinationPath)) {
    return null;
  }
  const preview = record.preview === undefined ? undefined : normalizePreview(record.preview);
  if (record.preview !== undefined && !preview) {
    return null;
  }
  const expectedSourceHash = record.expectedSourceHash === undefined ? undefined : readHash(record.expectedSourceHash);
  const expectedDestinationHash = record.expectedDestinationHash === undefined ? undefined : readHash(record.expectedDestinationHash);
  if ((record.expectedSourceHash !== undefined && !expectedSourceHash) || (record.expectedDestinationHash !== undefined && !expectedDestinationHash)) {
    return null;
  }
  return {
    operationId,
    operation,
    path,
    ...(destinationPath ? { destinationPath } : {}),
    summary: readSafeText(record.summary, 240),
    ...(expectedSourceHash ? { expectedSourceHash } : {}),
    ...(expectedDestinationHash ? { expectedDestinationHash } : {}),
    sourcePresent: record.sourcePresent === true,
    destinationPresent: record.destinationPresent === true,
    backupRequired: record.backupRequired === true,
    sizeBytes: readBoundedNumber(record.sizeBytes),
    lineCount: readBoundedNumber(record.lineCount),
    reviewable: record.reviewable === true,
    ...(preview ? { preview } : {})
  };
}

function normalizeCounts(value: unknown, operations: readonly ProposedChangeOperation[]): ProposedChangeSetSnapshot['counts'] {
  const record = asRecord(value);
  const fallback = {
    total: operations.length,
    creates: operations.filter((operation) => operation.operation === 'create').length,
    edits: operations.filter((operation) => operation.operation === 'edit').length,
    overwrites: operations.filter((operation) => operation.operation === 'overwrite').length,
    renames: operations.filter((operation) => operation.operation === 'rename').length,
    deletes: operations.filter((operation) => operation.operation === 'delete').length,
    destructive: operations.filter((operation) => operation.backupRequired).length
  };
  if (!record) return fallback;
  return {
    total: readBoundedNumber(record.total, fallback.total),
    creates: readBoundedNumber(record.creates, fallback.creates),
    edits: readBoundedNumber(record.edits, fallback.edits),
    overwrites: readBoundedNumber(record.overwrites, fallback.overwrites),
    renames: readBoundedNumber(record.renames, fallback.renames),
    deletes: readBoundedNumber(record.deletes, fallback.deletes),
    destructive: readBoundedNumber(record.destructive, fallback.destructive)
  };
}

function normalizeResult(value: unknown): ProposedChangeSetResult | undefined {
  const record = asRecord(value);
  if (!record || record.persisted !== true || !Array.isArray(record.operations)) {
    return undefined;
  }
  const operations = record.operations.map(normalizeOperationResult).filter((operation): operation is ProposedChangeOperationResult => operation !== null);
  if (operations.length !== record.operations.length) {
    return undefined;
  }
  const conflictPath = record.conflictPath === undefined ? undefined : safeRelativePath(record.conflictPath);
  if (record.conflictPath !== undefined && !conflictPath) return undefined;
  return {
    persisted: true,
    appliedCount: readBoundedNumber(record.appliedCount),
    skippedCount: readBoundedNumber(record.skippedCount),
    failedCount: readBoundedNumber(record.failedCount),
    backupCount: readBoundedNumber(record.backupCount),
    ...(conflictPath ? { conflictPath } : {}),
    operations
  };
}

function normalizeOperationResult(value: unknown): ProposedChangeOperationResult | null {
  const record = asRecord(value);
  const operationId = readString(record?.operationId);
  const operation = readOperation(record?.operation);
  const path = safeRelativePath(record?.path);
  const destinationPath = record?.destinationPath === undefined ? undefined : safeRelativePath(record.destinationPath);
  const status = readOperationStatus(record?.status);
  const backup = readBackupStatus(record?.backup);
  if (!record || !operationId || !operation || !path || !status || !backup || (record.destinationPath !== undefined && !destinationPath)) {
    return null;
  }
  return { operationId, operation, path, ...(destinationPath ? { destinationPath } : {}), status, backup, safeMessage: readSafeText(record.safeMessage, 500) };
}

function normalizePreview(value: unknown): ProposedChangePreview | undefined {
  const record = asRecord(value);
  const text = typeof record?.text === 'string' ? record.text : undefined;
  const kind = record?.kind === 'before' || record?.kind === 'after' || record?.kind === 'diff' ? record.kind : undefined;
  if (text === undefined || !kind || new TextEncoder().encode(text).byteLength > MAX_PREVIEW_BYTES || text.split(/\r\n|\r|\n/u).length > MAX_PREVIEW_LINES || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    return undefined;
  }
  return { text, kind, limited: record?.limited === true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readSafeText(value: unknown, maxLength: number): string {
  const candidate = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim() : '';
  return candidate.slice(0, maxLength);
}

function safeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    return null;
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  return normalized && !normalized.startsWith('/') && !/^[a-z]:/iu.test(normalized) && !/[\u0000-\u001f\u007f]/u.test(normalized) && !normalized.split('/').some((part) => part === '..') ? normalized : null;
}

function readHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
}

function readBoundedNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 2_147_483_647) : fallback;
}

function readIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function readSetStatus(value: unknown): ProposedChangeSetStatus | undefined {
  return typeof value === 'string' && SET_STATUSES.has(value as ProposedChangeSetStatus) ? value as ProposedChangeSetStatus : undefined;
}

function readDecision(value: unknown): ProposedChangeDecision | undefined {
  return typeof value === 'string' && DECISIONS.has(value as ProposedChangeDecision) ? value as ProposedChangeDecision : undefined;
}

function readOperation(value: unknown): ProposedChangeOperationKind | undefined {
  return typeof value === 'string' && OPERATION_KINDS.has(value as ProposedChangeOperationKind) ? value as ProposedChangeOperationKind : undefined;
}

function readOperationStatus(value: unknown): ProposedChangeOperationStatus | undefined {
  return value === 'applied' || value === 'skipped' || value === 'failed' || value === 'needs_manual_review' ? value : undefined;
}

function readBackupStatus(value: unknown): ProposedChangeBackupStatus | undefined {
  return value === 'not_required' || value === 'created' || value === 'failed' || value === 'unknown' ? value : undefined;
}

function invalidResponse(): ApiClientError {
  return new ApiClientError(200, 'INVALID_RESPONSE', 'The local app returned an invalid proposed change response.');
}
