import { ApiClientError, getJson, postJson } from '@/shared/api';
import { createIdempotencyKey } from '@/shared/lib/idempotency-key';
import type {
  SandboxCommandClassification,
  SandboxCommandDecision,
  SandboxCommandLimits,
  SandboxCommandResult,
  SandboxCommandSnapshot,
  SandboxCommandStatus,
  SandboxCommandTermination
} from '@/entities/ai-run/model/types';

const RUNS_PATH = '/api/v1/ai-runs';
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/iu;
const MAX_PREVIEW_BYTES = 4 * 1024;
const SECRET_ASSIGNMENT_PATTERN = /(?:api[_-]?key|access[_-]?(?:key|token)(?:[_-]?id)?|refresh[_-]?token|password|passwd|secret(?:[_-]?key)?|credential|token|private[_-]?key)\s*[:=]/iu;
const SECRET_ASSIGNMENT_REPLACE_PATTERN = /((?:api[_-]?key|access[_-]?(?:key|token)(?:[_-]?id)?|refresh[_-]?token|password|passwd|secret(?:[_-]?key)?|credential|token|private[_-]?key)\s*[:=]\s*["']?)[^\s"'`,;}]+/giu;
const ENV_ASSIGNMENT_PATTERN = /(?:^|\s)[A-Z_][A-Z0-9_]*\s*=/u;
const ENV_ASSIGNMENT_REPLACE_PATTERN = /((?:^|\s)[A-Z_][A-Z0-9_]*\s*=\s*["']?)[^\s"'`,;}]+/gu;
const GENERIC_ENV_ASSIGNMENT_REPLACE_PATTERN = /((?:^|\s)[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']?)[^\s"'`,;}]+/gu;
const EMBEDDED_ABSOLUTE_PATH_TEST_PATTERN = /(?:[a-z]:[\\/]|\/{1,2})[^\s"'`,;}]+/iu;
const EMBEDDED_ABSOLUTE_PATH_PATTERN = /(?:[a-z]:[\\/]|\/{1,2})[^\s"'`,;}]+/giu;

export interface SandboxCommandDecisionRequest {
  readonly proposalHash: string;
  readonly decision: 'approve' | 'reject';
}

export interface SandboxCommandListResponse {
  readonly commands: readonly SandboxCommandSnapshot[];
}

export function getSandboxCommands(runId: string): Promise<SandboxCommandListResponse> {
  return getJson<unknown>(`${RUNS_PATH}/${encodeURIComponent(runId)}/commands`).then(normalizeSandboxCommandList);
}

export function getSandboxCommand(runId: string, commandId: string): Promise<SandboxCommandSnapshot> {
  return getJson<unknown>(`${RUNS_PATH}/${encodeURIComponent(runId)}/commands/${encodeURIComponent(commandId)}`)
    .then(normalizeSandboxCommandResponse);
}

export function decideSandboxCommand(
  runId: string,
  commandId: string,
  request: SandboxCommandDecisionRequest,
  csrfToken: string,
  idempotencyKey: string = createIdempotencyKey()
): Promise<SandboxCommandSnapshot> {
  return postJson<unknown>(
    `${RUNS_PATH}/${encodeURIComponent(runId)}/commands/${encodeURIComponent(commandId)}/decision`,
    request,
    { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }
  ).then(normalizeSandboxCommandResponse);
}

export function cancelSandboxCommand(
  runId: string,
  commandId: string,
  csrfToken: string,
  idempotencyKey: string = createIdempotencyKey()
): Promise<SandboxCommandSnapshot> {
  return postJson<unknown>(
    `${RUNS_PATH}/${encodeURIComponent(runId)}/commands/${encodeURIComponent(commandId)}/cancel`,
    {},
    { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey }
  ).then(normalizeSandboxCommandResponse);
}

export function normalizeSandboxCommandList(value: unknown): SandboxCommandListResponse {
  const record = asRecord(value);
  const candidates = record?.commands ?? value;
  if (!Array.isArray(candidates)) {
    throw invalidResponse();
  }
  return { commands: candidates.map((candidate) => normalizeSandboxCommand(candidate)) };
}

export function normalizeSandboxCommandResponse(value: unknown): SandboxCommandSnapshot {
  const record = asRecord(value);
  const resource = record?.command ?? value;
  return normalizeSandboxCommand(resource);
}

export function normalizeSandboxCommand(value: unknown): SandboxCommandSnapshot {
  const record = asRecord(value);
  if (!record) {
    throw invalidResponse();
  }
  const commandId = readString(record.commandId) ?? readString(record.id);
  const runId = readString(record.runId);
  const proposalHash = readHash(record.proposalHash);
  const command = readCommandName(record.command);
  const classification = readClassification(record.classification);
  const decision = readDecision(record.decision);
  const status = readStatus(record.status);
  const limits = readLimits(record.limits);
  if (!commandId || !runId || !proposalHash || !command || !classification || !decision || !status || !limits) {
    throw invalidResponse();
  }
  const argumentSummaries = readArgumentSummaries(record.argumentSummaries);
  const argumentCount = readNumber(record.argumentCount, argumentSummaries.length);
  const result = normalizeResult(record.result);
  return {
    commandId,
    runId,
    proposalHash,
    command,
    summary: readSafeText(record.summary, `Run ${command} in the private staging area.`),
    argumentCount,
    argumentSummaries,
    cwd: readCwd(record.cwd),
    classification,
    decision,
    status,
    limits,
    ...(result ? { result } : {}),
    safeMessage: readSafeText(record.safeMessage, 'Review this command before it runs.'),
    createdAt: readString(record.createdAt) ?? '',
    updatedAt: readString(record.updatedAt) ?? ''
  };
}

function normalizeResult(value: unknown): SandboxCommandResult | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const termination = readTermination(record.termination);
  if (!termination) {
    return undefined;
  }
  const preview = readOutputPreview(record.outputPreview);
  return {
    exitCode: readNullableNumber(record.exitCode),
    termination,
    durationMs: readNumber(record.durationMs),
    outputBytes: readNumber(record.outputBytes),
    outputLineCount: readNumber(record.outputLineCount),
    outputTruncated: record.outputTruncated === true || termination === 'output_truncated',
    outputSha256: readHash(record.outputSha256) ?? '',
    ...(preview !== undefined ? { outputPreview: preview } : {})
  };
}

function readLimits(value: unknown): SandboxCommandLimits | undefined {
  const record = asRecord(value);
  if (!record || record.network !== 'denied') {
    return undefined;
  }
  return {
    wallTimeMs: readNumber(record.wallTimeMs),
    idleTimeMs: readNumber(record.idleTimeMs),
    maxOutputBytes: readNumber(record.maxOutputBytes),
    maxProcesses: readNumber(record.maxProcesses),
    memoryBytes: readNumber(record.memoryBytes),
    cpuTimeMs: readNumber(record.cpuTimeMs),
    network: 'denied'
  };
}

function readArgumentSummaries(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((candidate) => readSafeArgument(candidate))
    .filter((candidate): candidate is string => candidate !== undefined);
}

function readSafeArgument(value: unknown): string | undefined {
  const candidate = readString(value);
  if (!candidate || candidate.length > 256 || /[\u0000-\u001f\u007f]/u.test(candidate)) {
    return undefined;
  }
  if (/^(?:[a-z]:[\\/]|[\\/])|\.\.(?:[\\/]|$)|(?:NVIDIA_API_KEY|PASSWORD|TOKEN|SECRET|PRIVATE_KEY)/iu.test(candidate) || SECRET_ASSIGNMENT_PATTERN.test(candidate) || ENV_ASSIGNMENT_PATTERN.test(candidate) || EMBEDDED_ABSOLUTE_PATH_TEST_PATTERN.test(candidate)) {
    return '[redacted]';
  }
  return candidate;
}

function readOutputPreview(value: unknown): string | undefined {
  const candidate = readString(value);
  if (candidate === undefined || new TextEncoder().encode(candidate).byteLength > MAX_PREVIEW_BYTES) {
    return undefined;
  }
  return candidate.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').replace(SECRET_ASSIGNMENT_REPLACE_PATTERN, '$1[REDACTED]').replace(GENERIC_ENV_ASSIGNMENT_REPLACE_PATTERN, '$1[REDACTED]').replace(EMBEDDED_ABSOLUTE_PATH_PATTERN, '[REDACTED_PATH]');
}

function readCommandName(value: unknown): string | undefined {
  const candidate = readString(value);
  return candidate && COMMAND_NAME_PATTERN.test(candidate) ? candidate : undefined;
}

function readCwd(value: unknown): string {
  const candidate = readString(value)?.trim().replaceAll('\\', '/');
  if (!candidate || candidate.startsWith('/') || /^[a-z]:/iu.test(candidate) || candidate.split('/').some((part) => part === '..' || part.length === 0)) {
    return '.';
  }
  return redactSafeText(candidate);
}

function readSafeText(value: unknown, fallback: string): string {
  const candidate = readString(value);
  if (!candidate || candidate.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(candidate)) {
    return fallback;
  }
  return redactSafeText(candidate);
}

function redactSafeText(value: string): string {
  return value.replace(SECRET_ASSIGNMENT_REPLACE_PATTERN, '$1[REDACTED]').replace(ENV_ASSIGNMENT_REPLACE_PATTERN, '$1[REDACTED]').replace(EMBEDDED_ABSOLUTE_PATH_PATTERN, '[REDACTED_PATH]');
}

function readHash(value: unknown): string | undefined {
  return typeof value === 'string' && HASH_PATTERN.test(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function readNullableNumber(value: unknown): number | null {
  return value === null ? null : readNumber(value);
}

function readClassification(value: unknown): SandboxCommandClassification | undefined {
  return value === 'safe' || value === 'sensitive' || value === 'blocked' ? value : undefined;
}

function readDecision(value: unknown): SandboxCommandDecision | undefined {
  return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'not_applicable' ? value : undefined;
}

function readStatus(value: unknown): SandboxCommandStatus | undefined {
  return value === 'awaiting_approval' || value === 'running' || value === 'completed' || value === 'failed'
    || value === 'timed_out' || value === 'output_truncated' || value === 'rejected' || value === 'blocked'
    || value === 'cancel_requested' || value === 'cancelled' || value === 'review_required' ? value : undefined;
}

function readTermination(value: unknown): SandboxCommandTermination | undefined {
  return value === 'completed' || value === 'failed' || value === 'timed_out' || value === 'output_truncated' || value === 'cancelled' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function invalidResponse(): ApiClientError {
  return new ApiClientError(200, 'INVALID_RESPONSE', 'The local app returned an invalid sandbox command response.');
}
