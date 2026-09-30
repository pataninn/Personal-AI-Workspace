import { ApiClientError, getJson } from '@/shared/api';
import type { ProjectFileHistoryItem, ProjectFileHistoryOutcome, ProjectFileHistoryPage } from '@/entities/ai-run/model/file-history-types';

const PROJECTS_PATH = '/api/v1/projects';
const OPERATIONS = new Set(['create', 'edit', 'overwrite', 'rename', 'delete']);
const CHANGE_SET_STATUSES = new Set(['awaiting_approval', 'applying', 'applied', 'rejected', 'stale', 'blocked', 'failed', 'needs_manual_review']);
const OPERATION_STATUSES = new Set(['applied', 'skipped', 'failed', 'needs_manual_review']);
const BACKUP_STATUSES = new Set(['not_required', 'created', 'failed', 'unknown', 'pending', 'not_created']);

export async function listProjectFileHistory(projectId: string, path: string, outcome: ProjectFileHistoryOutcome, cursor?: string): Promise<ProjectFileHistoryPage> {
  const query = new URLSearchParams({ path, outcome, limit: '20' });
  if (cursor) query.set('cursor', cursor);
  const value = await getJson<unknown>(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}/file-history?${query.toString()}`);
  const record = asRecord(value);
  if (record?.projectId !== projectId || record.path !== path || record.outcome !== outcome || !Array.isArray(record.items)) throw invalidResponse();
  return { projectId, path, outcome, items: record.items.map((item) => normalizeItem(item, projectId, path)), nextCursor: nullableString(record.nextCursor) };
}

function normalizeItem(value: unknown, projectId: string, path: string): ProjectFileHistoryItem {
  const record = asRecord(value);
  if (!record || record.projectId !== projectId || string(record.matchedPath) !== path) throw invalidResponse();
  const operation = string(record.operation);
  const changeSetStatus = string(record.changeSetStatus);
  const operationStatus = record.operationStatus === null ? null : string(record.operationStatus);
  const backupStatus = string(record.backupStatus);
  if (!OPERATIONS.has(operation) || !CHANGE_SET_STATUSES.has(changeSetStatus) || (operationStatus !== null && !OPERATION_STATUSES.has(operationStatus)) || !BACKUP_STATUSES.has(backupStatus)) throw invalidResponse();
  const destinationPath = record.destinationPath === undefined ? undefined : string(record.destinationPath);
  const conversationId = record.conversationId === null ? null : string(record.conversationId);
  return {
    changeSetId: string(record.changeSetId), projectId, runId: string(record.runId), conversationId,
    operationId: string(record.operationId), operationIndex: nonNegativeInteger(record.operationIndex),
    operation: operation as ProjectFileHistoryItem['operation'], matchedPath: path, path: string(record.path),
    ...(destinationPath ? { destinationPath } : {}), summary: safeSummary(record.summary), changeSetStatus,
    operationStatus: operationStatus as ProjectFileHistoryItem['operationStatus'],
    backupStatus: backupStatus as ProjectFileHistoryItem['backupStatus'],
    createdAt: isoDate(record.createdAt), updatedAt: isoDate(record.updatedAt)
  };
}

function safeSummary(value: unknown): string {
  const candidate = string(value).replace(/[\u0000-\u001f\u007f]/gu, ' ');
  if (new TextEncoder().encode(candidate).byteLength > 240) throw invalidResponse();
  return candidate;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw invalidResponse();
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return string(value);
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw invalidResponse();
}

function isoDate(value: unknown): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  throw invalidResponse();
}

function invalidResponse(): ApiClientError {
  return new ApiClientError(200, 'INVALID_RESPONSE', 'The local app returned invalid file history.');
}
