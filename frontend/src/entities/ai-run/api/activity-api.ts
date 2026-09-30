import { ApiClientError, getJson } from '@/shared/api';
import type { AiRunActivityDetail, AiRunActivityFilter, AiRunActivityItem, AiRunActivityPage, AiRunActivityUsage, AiRunActivityUsageStatus } from '@/entities/ai-run/model/activity-types';

const PROJECTS_PATH = '/api/v1/projects';
const RUNS_PATH = '/api/v1/ai-runs';
const STATUSES = new Set(['pending_approval', 'rejected', 'staging', 'ready', 'queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'blocked', 'review_required']);
const DECISIONS = new Set(['pending', 'approved', 'rejected']);
const TRANSMISSIONS = new Set(['not_started', 'not_started_confirmed', 'transmitted_confirmed', 'unknown']);
const USAGE_STATUSES = new Set<AiRunActivityUsageStatus>(['reported', 'partial', 'not_reported', 'not_transmitted', 'unknown', 'unavailable']);
const CHANGE_STATUSES = new Set(['awaiting_approval', 'applying', 'applied', 'rejected', 'stale', 'blocked', 'failed', 'needs_manual_review']);

export async function listAiRunActivity(projectId: string, filter: AiRunActivityFilter, cursor?: string): Promise<AiRunActivityPage> {
  const query = new URLSearchParams({ limit: '20', filter });
  if (cursor) query.set('cursor', cursor);
  const value = await getJson<unknown>(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}/ai-runs?${query.toString()}`);
  const record = asRecord(value);
  if (record?.projectId !== projectId || !Array.isArray(record.items)) throw invalidResponse();
  return {
    projectId,
    items: record.items.map((item) => normalizeItem(item, projectId)),
    nextCursor: readNullableString(record.nextCursor)
  };
}

export async function getAiRunActivity(runId: string): Promise<AiRunActivityDetail> {
  const value = await getJson<unknown>(`${RUNS_PATH}/${encodeURIComponent(runId)}/activity`);
  const record = asRecord(value);
  const base = normalizeItem(record, readString(record?.projectId));
  if (base.runId !== runId || !Array.isArray(record?.selectedFiles) || !Array.isArray(record.selectedFactTitles) || !Array.isArray(record.operations)) throw invalidResponse();
  return {
    ...base,
    assistantPreview: readNullableString(record.assistantPreview),
    selectedFiles: record.selectedFiles.map(readString),
    selectedFactTitles: record.selectedFactTitles.map(readString),
    operations: record.operations.map((operation) => {
      const item = asRecord(operation);
      return { operation: readString(item?.operation), path: readString(item?.path), outcome: readString(item?.outcome), backupStatus: readString(item?.backupStatus) };
    }),
    omittedOperationCount: readNonNegativeInteger(record.omittedOperationCount)
  };
}

function normalizeItem(value: unknown, projectId: string): AiRunActivityItem {
  const record = asRecord(value);
  const context = asRecord(record?.context);
  const cost = asRecord(record?.cost);
  const changeSet = record?.changeSet === null ? null : readChangeSummary(record?.changeSet);
  const item: AiRunActivityItem = {
    runId: readString(record?.runId),
    projectId: readString(record?.projectId),
    conversationId: readString(record?.conversationId),
    status: readEnum(record?.status, STATUSES) as AiRunActivityItem['status'],
    decision: readEnum(record?.decision, DECISIONS) as AiRunActivityItem['decision'],
    providerTransmission: readEnum(record?.providerTransmission, TRANSMISSIONS) as AiRunActivityItem['providerTransmission'],
    createdAt: readString(record?.createdAt),
    updatedAt: readString(record?.updatedAt),
    provider: readString(record?.provider),
    model: readString(record?.model),
    requestPreview: readString(record?.requestPreview),
    context: {
      categories: readStringArray(context?.categories),
      fileCount: readNonNegativeInteger(context?.fileCount),
      factCount: readNonNegativeInteger(context?.factCount),
      messageCount: readNonNegativeInteger(context?.messageCount),
      estimatedTokens: readNonNegativeInteger(context?.estimatedTokens)
    },
    usage: readUsage(record?.usage),
    cost: { status: readEnum(cost?.status, new Set(['unavailable'])) as 'unavailable', label: readString(cost?.label) },
    changeSet
  };
  if (item.projectId !== projectId) throw invalidResponse();
  return item;
}

function readUsage(value: unknown): AiRunActivityUsage {
  const record = asRecord(value);
  return {
    status: readEnum(record?.status, USAGE_STATUSES),
    promptTokens: readNullableInteger(record?.promptTokens),
    completionTokens: readNullableInteger(record?.completionTokens),
    totalTokens: readNullableInteger(record?.totalTokens)
  };
}

function readChangeSummary(value: unknown): AiRunActivityItem['changeSet'] {
  const record = asRecord(value);
  return {
    status: readEnum(record?.status, CHANGE_STATUSES),
    operationCount: readNonNegativeInteger(record?.operationCount),
    appliedCount: readNonNegativeInteger(record?.appliedCount),
    skippedCount: readNonNegativeInteger(record?.skippedCount),
    failedCount: readNonNegativeInteger(record?.failedCount),
    backupCount: readNonNegativeInteger(record?.backupCount)
  };
}

function readString(value: unknown): string {
  if (typeof value === 'string') return value;
  throw invalidResponse();
}

function readNullableString(value: unknown): string | null {
  if (value === null) return null;
  return readString(value);
}

function readNonNegativeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw invalidResponse();
}

function readNullableInteger(value: unknown): number | null {
  if (value === null) return null;
  return readNonNegativeInteger(value);
}

function readEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>): T {
  if (typeof value === 'string' && allowed.has(value as T)) return value as T;
  throw invalidResponse();
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map(readString);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function invalidResponse(): ApiClientError {
  return new ApiClientError(200, 'INVALID_RESPONSE', 'The local app returned invalid activity history.');
}
