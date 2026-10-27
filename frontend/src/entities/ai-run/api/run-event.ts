import type { AiRunPhase, AiRunStatus } from '@/entities/ai-run/model/types';

export type AiRunEventType = 'run.snapshot' | 'run.started' | 'run.status_changed' | 'assistant.delta' | 'assistant.message.completed' | 'tool.proposed' | 'approval.required' | 'approval.decided' | 'tool.started' | 'tool.completed' | 'tool.failed' | 'tool.progress' | 'run.completed' | 'run.failed' | 'run.blocked' | 'run.cancel_requested' | 'run.cancelled' | 'run.needs_manual_review';

export interface AiRunEvent {
  readonly runId: string;
  readonly type: AiRunEventType;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

const MAX_EVENT_BYTES = 32 * 1024;
const MAX_DELTA_BYTES = 4 * 1024;
const EVENT_TYPES = new Set<AiRunEventType>([
  'run.snapshot', 'run.started', 'run.status_changed', 'assistant.delta', 'assistant.message.completed', 'tool.proposed', 'approval.required', 'approval.decided', 'tool.started', 'tool.completed', 'tool.failed', 'tool.progress', 'run.completed', 'run.failed', 'run.blocked', 'run.cancel_requested', 'run.cancelled', 'run.needs_manual_review'
]);

export function parseAiRunEvent(value: unknown): AiRunEvent | null {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_EVENT_BYTES) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }
  const record = asRecord(decoded);
  const runId = readString(record?.runId);
  const type = record?.type;
  const sequence = record?.sequence;
  const payload = asRecord(record?.payload);
  if (!runId || typeof type !== 'string' || !EVENT_TYPES.has(type as AiRunEventType) || typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0 || !payload) {
    return null;
  }
  const safePayload = normalizePayload(type as AiRunEventType, payload);
  return safePayload ? { runId, type: type as AiRunEventType, sequence, payload: safePayload } : null;
}

function normalizePayload(type: AiRunEventType, payload: Record<string, unknown>): Readonly<Record<string, unknown>> | null {
  if (type === 'tool.progress') {
    return { toolId: readString(payload.toolId) ?? '', title: readSafeMessage(payload.title) ?? 'Hermes tool', status: readString(payload.status) ?? 'running' };
  }
  if (type === 'run.snapshot') {
    const runId = readString(payload.runId);
    const projectId = readString(payload.projectId);
    const conversationId = readString(payload.conversationId);
    const manifestHash = readString(payload.manifestHash);
    const status = readStatus(payload.status);
    const phase = readPhase(payload.phase);
    const decision = payload.decision === 'pending' || payload.decision === 'approved' || payload.decision === 'rejected' || payload.decision === 'policy_authorized' ? payload.decision : undefined;
    if (!runId || !projectId || !conversationId || !manifestHash || !status || !phase || !decision) {
      return null;
    }
    const result: Record<string, unknown> = {
      runId,
      projectId,
      conversationId,
      status,
      phase,
      manifestHash,
      decision,
      safeMessage: readSafeMessage(payload.safeMessage) ?? '',
      cleanup: payload.cleanup === 'complete' || payload.cleanup === 'unknown' ? payload.cleanup : 'not_started',
      providerTransmission: payload.providerTransmission === 'not_started_confirmed' || payload.providerTransmission === 'transmitted_confirmed' || payload.providerTransmission === 'unknown' ? payload.providerTransmission : 'not_started',
      stagingItemCount: nonNegativeNumber(payload.stagingItemCount)
    };
    const runtime = asRecord(payload.runtime);
    if ((runtime?.kind === 'fake' || runtime?.kind === 'direct' || runtime?.kind === 'hermes') && runtime.sandboxReady === true) {
      result.runtime = { kind: runtime.kind, sandboxReady: true };
    }
    const assistant = asRecord(payload.assistant);
    if (assistant) {
      result.assistant = {
        ...(readString(assistant.messageId) ? { messageId: readString(assistant.messageId) } : {}),
        complete: assistant.complete === true,
        contentLength: nonNegativeNumber(assistant.contentLength)
      };
    }
    return result;
  }
  if (type === 'assistant.delta') {
    const text = readString(payload.text);
    if (!text) {
      return null;
    }
    return { text: truncateText(text, MAX_DELTA_BYTES), ...(readString(payload.messageId) ? { messageId: readString(payload.messageId) } : {}) };
  }
  if (type === 'assistant.message.completed') {
    const contentLength = nonNegativeNumber(payload.contentLength);
    return { contentLength, empty: payload.empty === true };
  }
  const status = readStatus(payload.status);
  const phase = readPhase(payload.phase);
  const safeMessage = readSafeMessage(payload.safeMessage);
  const result: Record<string, unknown> = {};
  if (status) {
    result.status = status;
  }
  if (phase) {
    result.phase = phase;
  }
  if (safeMessage) {
    result.safeMessage = safeMessage;
  }
  const commandId = readString(payload.commandId);
  if (commandId) {
    result.commandId = commandId;
  }
  const contentLength = payload.contentLength;
  if (typeof contentLength === 'number' && Number.isFinite(contentLength) && contentLength >= 0) {
    result.contentLength = Math.floor(contentLength);
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readSafeMessage(value: unknown): string | undefined {
  const message = readString(value);
  return message && message.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(message) ? message : undefined;
}

function readStatus(value: unknown): AiRunStatus | undefined {
  return value === 'pending_approval' || value === 'rejected' || value === 'staging' || value === 'ready' || value === 'queued' || value === 'running' || value === 'waiting_approval' || value === 'succeeded' || value === 'failed' || value === 'cancel_requested' || value === 'cancelled' || value === 'blocked' || value === 'review_required' ? value : undefined;
}

function readPhase(value: unknown): AiRunPhase | undefined {
  return value === 'manifest' || value === 'decision' || value === 'staging' || value === 'runtime' || value === 'inference' || value === 'terminal' || value === 'review' ? value : undefined;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function truncateText(value: string, maxBytes: number): string {
  if (new TextEncoder().encode(value).byteLength <= maxBytes) {
    return value;
  }
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}
