export const PROJECT_ID = '873c096a-bc57-4a0c-85da-10d4febde96b';
export const CONVERSATION_ID = '489541da-57a5-416d-afb6-45b19ad7bc98';
export const OWNER_ID = '116cfd7c-e76f-4de4-bda1-001d6c3fbf16';
export const PROVIDER_PROFILE = 'synthetic-preview-provider';
export const PROVIDER = 'Synthetic browser fixture';
export const MODEL = 'preview-only';
export const PREVIEW_CSRF_TOKEN = 'preview-only-csrf-token';
export const PREVIEW_TIME = '2026-10-16T00:00:00.000Z';

export type RunPlan = 'policy' | 'policy-unavailable' | 'cancellation' | 'recovery';

export interface RunSnapshot {
  readonly runId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly status: string;
  readonly phase: string;
  readonly manifestHash: string;
  readonly decision: string;
  readonly safeMessage: string;
  readonly cleanup: string;
  readonly providerTransmission: string;
  readonly stagingItemCount: number;
}

export interface ApiRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly idempotencyKey: string | null;
  readonly csrfToken: string | null;
}

export interface BrowserEvidence {
  readonly requests: ApiRequestRecord[];
  readonly responses: Array<{ readonly path: string; readonly status: number }>;
  readonly lifecycle: Array<{ readonly step: 'request' | 'response' | 'finished' | 'failed'; readonly method: string; readonly path: string; readonly status?: number; readonly failure?: string | null }>;
  readonly failedRequests: Array<{ readonly url: string; readonly failure: string | null }>;
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly blockedExternalRequests: string[];
}

export function safeBody(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value) as unknown; } catch { return '<unparsed>'; }
}

export function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
