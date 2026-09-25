import {
  MAX_BRIDGE_DEADLINE_MS,
  OPEN_SHELL_BRIDGE_PROTOCOL_VERSION,
  OpenShellBridgeProtocolError,
  type BridgeFrame,
  type BridgeJsonObject,
  type BridgeOperation,
  type BridgeRequestFrame,
  type BridgeResponseFrame
} from '@/infrastructure/sandbox/openshell-bridge-types';

export function validateBridgeFrame(frame: BridgeFrame): void {
  if (frame.kind === 'request') {
    validateRequestFrame(frame);
    return;
  }
  validateResponseFrame(frame);
}

export function parseBridgeFrame(value: unknown, nowEpochMs = Date.now()): BridgeFrame {
  const record = requireObject(value, 'The bridge frame must be a JSON object.');
  const kind = requireString(record.kind, 'The bridge frame kind is invalid.');
  if (kind === 'request') {
    return parseRequestFrame(record, nowEpochMs);
  }
  if (kind === 'response') {
    return parseResponseFrame(record);
  }
  throw new OpenShellBridgeProtocolError('The bridge frame kind is unsupported.');
}

function validateRequestFrame(frame: BridgeRequestFrame): void {
  validateCommon(frame, frame.deadlineEpochMs);
  validateCapability(frame.capability);
  validatePayload(frame.operation, frame.payload);
}

function validateResponseFrame(frame: BridgeResponseFrame): void {
  if (frame.protocolVersion !== OPEN_SHELL_BRIDGE_PROTOCOL_VERSION || !isBridgeOperation(frame.operation)) {
    throw new OpenShellBridgeProtocolError('The bridge response version or operation is invalid.');
  }
  validateRunId(frame.runId);
  validatePositiveInteger(frame.requestId, 'request id');
  validatePositiveInteger(frame.bridgeSequence, 'bridge sequence');
  if (!isBridgeOutcome(frame.outcome) || !isDigest(frame.receiptDigest)) {
    throw new OpenShellBridgeProtocolError('The bridge response outcome or receipt is invalid.');
  }
  requireObject(frame.payload, 'The bridge response payload is invalid.');
  if (frame.errorCode !== undefined) {
    validateShortString(frame.errorCode, 'bridge error code');
  }
}

function parseRequestFrame(record: BridgeJsonObject, nowEpochMs: number): BridgeRequestFrame {
  const common = parseCommon(record, nowEpochMs);
  const capability = requireString(record.capability, 'The bridge capability is invalid.');
  validateCapability(capability);
  const operation = parseOperation(record.operation);
  const payload = requireObject(record.payload, 'The bridge request payload is invalid.');
  validatePayload(operation, payload);
  return { kind: 'request', ...common, operation, capability, payload };
}

function parseResponseFrame(record: BridgeJsonObject): BridgeResponseFrame {
  const operation = parseOperation(record.operation);
  const outcome = record.outcome;
  if (!isBridgeOutcome(outcome)) {
    throw new OpenShellBridgeProtocolError('The bridge response outcome is invalid.');
  }
  const payload = requireObject(record.payload, 'The bridge response payload is invalid.');
  const frame: BridgeResponseFrame = {
    kind: 'response',
    protocolVersion: requireNumber(record.protocolVersion, 'protocol version'),
    operation,
    runId: requireString(record.runId, 'run id'),
    requestId: requireNumber(record.requestId, 'request id'),
    bridgeSequence: requireNumber(record.bridgeSequence, 'bridge sequence'),
    outcome,
    receiptDigest: requireString(record.receiptDigest, 'receipt digest'),
    payload,
    ...(record.errorCode !== undefined ? { errorCode: requireString(record.errorCode, 'error code') } : {})
  };
  validateResponseFrame(frame);
  return frame;
}

function parseCommon(record: BridgeJsonObject, nowEpochMs: number): Omit<BridgeRequestFrame, 'kind' | 'operation' | 'capability' | 'payload'> {
  const protocolVersion = requireNumber(record.protocolVersion, 'protocol version');
  const requestId = requireNumber(record.requestId, 'request id');
  const deadlineEpochMs = requireNumber(record.deadlineEpochMs, 'deadline');
  if (protocolVersion !== OPEN_SHELL_BRIDGE_PROTOCOL_VERSION) {
    throw new OpenShellBridgeProtocolError('The bridge protocol version is unsupported.');
  }
  const runId = requireString(record.runId, 'run id');
  validateRunId(runId);
  validatePositiveInteger(requestId, 'request id');
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= nowEpochMs || deadlineEpochMs > nowEpochMs + MAX_BRIDGE_DEADLINE_MS) {
    throw new OpenShellBridgeProtocolError('The bridge request deadline is outside the safe window.');
  }
  return { protocolVersion, runId, requestId, deadlineEpochMs };
}

function validateCommon(frame: BridgeRequestFrame, deadlineEpochMs: number): void {
  if (frame.protocolVersion !== OPEN_SHELL_BRIDGE_PROTOCOL_VERSION || !isBridgeOperation(frame.operation)) {
    throw new OpenShellBridgeProtocolError('The bridge request version or operation is invalid.');
  }
  validateRunId(frame.runId);
  validatePositiveInteger(frame.requestId, 'request id');
  const now = Date.now();
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= now || deadlineEpochMs > now + MAX_BRIDGE_DEADLINE_MS) {
    throw new OpenShellBridgeProtocolError('The bridge request deadline is outside the safe window.');
  }
}

function validatePayload(operation: BridgeOperation, payload: BridgeJsonObject): void {
  if (operation === 'probe') {
    validateDigest(payload.profileDigest, 'profile digest');
  } else if (operation === 'create') {
    validateDigest(payload.manifestDigest, 'manifest digest');
    validateDigest(payload.profileDigest, 'profile digest');
  } else if (operation === 'upload') {
    validateDigest(payload.manifestDigest, 'manifest digest');
    validatePositiveInteger(payload.archiveBytes, 'archive bytes');
    validateRunDestination(payload.remoteDestination);
  } else if (operation === 'exec') {
    validateExecPayload(payload);
  } else if (operation === 'acp.send') {
    requireObject(payload.frame, 'ACP frame');
  }
}

function validateExecPayload(payload: BridgeJsonObject): void {
  validateShortString(payload.commandId, 'command id');
  if (!Array.isArray(payload.argv) || payload.argv.length === 0 || payload.argv.length > 32 || payload.argv.some((part) => typeof part !== 'string' || part.length === 0 || part.includes('\0'))) {
    throw new OpenShellBridgeProtocolError('The bridge argv is invalid.');
  }
  validateRelativePath(payload.cwd, 'working directory');
  const timeoutSeconds = payload.timeoutSeconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
    throw new OpenShellBridgeProtocolError('The bridge command timeout is invalid.');
  }
}

function validateRunId(value: string): void {
  if (!/^run-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value)) {
    throw new OpenShellBridgeProtocolError('The bridge run id is invalid.');
  }
}

function validateRunDestination(value: unknown): void {
  if (typeof value !== 'string' || !/^run-[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/u.test(value)) {
    throw new OpenShellBridgeProtocolError('The bridge destination is invalid.');
  }
}

function validateRelativePath(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\0') || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new OpenShellBridgeProtocolError(`The bridge ${label} is invalid.`);
  }
}

function validateDigest(value: unknown, label: string): void {
  if (typeof value !== 'string' || !isDigest(value)) {
    throw new OpenShellBridgeProtocolError(`The bridge ${label} is invalid.`);
  }
}

function validateCapability(value: string): void {
  if (!/^[A-Za-z0-9._~-]{32,256}$/u.test(value)) {
    throw new OpenShellBridgeProtocolError('The bridge capability is invalid.');
  }
}

function validateShortString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('\0')) {
    throw new OpenShellBridgeProtocolError(`The bridge ${label} is invalid.`);
  }
  return value;
}

function requireObject(value: unknown, message: string): BridgeJsonObject {
  if (!isJsonObject(value)) {
    throw new OpenShellBridgeProtocolError(message);
  }
  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throw new OpenShellBridgeProtocolError(message);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OpenShellBridgeProtocolError(`The bridge ${label} is invalid.`);
  }
  return value;
}

function validatePositiveInteger(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new OpenShellBridgeProtocolError(`The bridge ${label} is invalid.`);
  }
}

function parseOperation(value: unknown): BridgeOperation {
  if (!isBridgeOperation(value)) {
    throw new OpenShellBridgeProtocolError('The bridge operation is unsupported.');
  }
  return value;
}

function isBridgeOperation(value: unknown): value is BridgeOperation {
  return typeof value === 'string' && ['probe', 'create', 'upload', 'exec', 'acp.open', 'acp.send', 'acp.cancel', 'status', 'delete'].includes(value);
}

function isBridgeOutcome(value: unknown): value is BridgeResponseFrame['outcome'] {
  return typeof value === 'string' && ['ok', 'unavailable', 'rejected', 'unknown', 'review_required'].includes(value);
}

function isDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isJsonObject(value: unknown): value is BridgeJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
