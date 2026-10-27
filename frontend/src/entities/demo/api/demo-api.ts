import { ApiClientError, getJson, postJson } from '@/shared/api';
import type { SessionSnapshot } from '@/entities/user-session';
import type { DemoAdmissionResult, DemoAvailability, DemoShowcaseCopy } from '@/entities/demo/model/types';

const DEMO_SESSION_PATH = '/api/v1/demo/session';
const DEMO_AVAILABILITY_PATH = '/api/v1/demo/availability';
const DEMO_COPY_PATH = '/api/v1/demo/showcase-copy';
const DEMO_COPY_RETRY_PATH = `${DEMO_COPY_PATH}/retries`;

/** Checks the public admission state without sending the current session cookie. */
export async function getDemoAvailability(): Promise<DemoAvailability> {
  const response = await fetchPublicJson(DEMO_AVAILABILITY_PATH);
  const available = asRecord(response)?.available;
  if (typeof available !== 'boolean') {
    throw invalidResponse();
  }
  return { available };
}

/** Starts or resumes a demo using the Task 3.3 same-key behavior. */
export async function createDemoSession(idempotencyKey: string): Promise<DemoAdmissionResult> {
  const response = await postJson<unknown>(DEMO_SESSION_PATH, {}, { 'Idempotency-Key': idempotencyKey });
  return normalizeDemoAdmission(response);
}

/** Returns the copy readiness for the current demo cookie. */
export async function getDemoShowcaseCopy(): Promise<DemoShowcaseCopy> {
  return normalizeDemoShowcaseCopy(await getJson<unknown>(DEMO_COPY_PATH));
}

/** Retries only the server-approved current copy job. */
export async function retryDemoShowcaseCopy(csrfToken: string): Promise<DemoShowcaseCopy> {
  const response = await postJson<unknown>(DEMO_COPY_RETRY_PATH, {}, { 'X-CSRF-Token': csrfToken });
  return normalizeDemoShowcaseCopy(response);
}

/** Creates the 32-byte base64url key required for an anonymous admission. */
export function createDemoAdmissionKey(cryptoSource: Crypto = globalThis.crypto): string {
  if (typeof cryptoSource?.getRandomValues !== 'function') {
    throw new Error('Secure randomness is unavailable.');
  }
  const bytes = cryptoSource.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function normalizeDemoAdmission(value: unknown): DemoAdmissionResult {
  const record = asRecord(value);
  if (record?.state === 'pending') {
    return { state: 'pending' };
  }
  if (record?.state !== 'ready') {
    throw invalidResponse();
  }
  if (!('principal' in record)) {
    return { state: 'ready' };
  }
  const principal = asRecord(record.principal);
  if (!principal) {
    throw invalidResponse();
  }
  const snapshot = normalizeSessionSnapshot(record, principal);
  if (snapshot.principal.accountKind !== 'demo' || snapshot.principal.role !== 'user') {
    throw invalidResponse();
  }
  return { state: 'ready', ...snapshot };
}

function normalizeSessionSnapshot(record: Record<string, unknown>, principal: Record<string, unknown>): SessionSnapshot {
  const accountKind = principal.accountKind;
  const role = principal.role;
  if ((accountKind !== 'demo' && accountKind !== 'regular') || (role !== 'user' && role !== 'admin')) {
    throw invalidResponse();
  }
  return {
    principal: {
      id: readNonEmptyString(principal.id),
      displayName: readNonEmptyString(principal.displayName),
      accountKind,
      role
    },
    csrfToken: readNonEmptyString(record.csrfToken),
    expiresAt: readNonEmptyString(record.expiresAt)
  };
}

function normalizeDemoShowcaseCopy(value: unknown): DemoShowcaseCopy {
  const record = asRecord(value);
  if (!record || (record.state !== 'pending' && record.state !== 'ready' && record.state !== 'failed') || typeof record.retryAllowed !== 'boolean') {
    throw invalidResponse();
  }
  const projectId = record.projectId === null ? null : readUuid(record.projectId);
  if ((record.state === 'ready') !== (projectId !== null)) {
    throw invalidResponse();
  }
  const capabilities = record.capabilities === null ? null : normalizeCapabilities(record.capabilities);
  const workspaceMode = record.workspaceMode;
  if (workspaceMode !== null && workspaceMode !== 'planning' && workspaceMode !== 'file_backed') {
    throw invalidResponse();
  }
  if (record.state === 'ready' && (!capabilities || workspaceMode === null)) {
    throw invalidResponse();
  }
  if (record.state !== 'ready' && (capabilities || workspaceMode !== null)) {
    throw invalidResponse();
  }
  return { state: record.state, projectId, retryAllowed: record.retryAllowed, workspaceMode, capabilities };
}

function normalizeCapabilities(value: unknown): { readonly planning: true; readonly fileAccess: boolean } {
  const record = asRecord(value);
  if (record?.planning !== true || typeof record.fileAccess !== 'boolean') {
    throw invalidResponse();
  }
  return { planning: true, fileAccess: record.fileAccess };
}

async function fetchPublicJson(path: string): Promise<unknown> {
  const response = await fetch(path, { credentials: 'omit', headers: { Accept: 'application/json' } });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw invalidResponse();
  }
  const envelope = asRecord(body);
  const error = asRecord(envelope?.error);
  if (!envelope || !('data' in envelope) || !('error' in envelope)) {
    throw invalidResponse();
  }
  if (!response.ok || error) {
    throw new ApiClientError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'HTTP_ERROR',
      typeof error?.message === 'string' ? error.message : 'The request failed.'
    );
  }
  return envelope.data;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNonEmptyString(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  throw invalidResponse();
}

function readUuid(value: unknown): string {
  if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    return value;
  }
  throw invalidResponse();
}

function invalidResponse(): ApiClientError {
  return new ApiClientError(200, 'INVALID_RESPONSE', 'The local app returned an invalid response.');
}
