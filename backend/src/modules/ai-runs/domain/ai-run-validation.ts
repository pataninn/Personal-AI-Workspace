import { AiRunIdempotencyRequiredError, AiRunValidationError } from '@/modules/ai-runs/domain/ai-run-errors';
import { containsPotentialSecret } from '@/shared/egress/redaction';

const MAX_REQUEST_BYTES = 8_000;
const MAX_PATHS = 100;
const MAX_IDEMPOTENCY_LENGTH = 200;

export function validateRequest(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AiRunValidationError([{ field: 'request', message: 'Request must be a string.' }]);
  }
  const request = value.trim();
  if (request.length === 0) {
    throw new AiRunValidationError([{ field: 'request', message: 'Request must not be empty.' }]);
  }
  if (Buffer.byteLength(request, 'utf8') > MAX_REQUEST_BYTES) {
    throw new AiRunValidationError([{ field: 'request', message: 'Request is larger than the safe limit.' }]);
  }
  if (containsPotentialSecret(request)) {
    throw new AiRunValidationError([{ field: 'request', message: 'Requests containing credential-like values cannot be sent.' }]);
  }
  return request;
}

export function validateContextPaths(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_PATHS || value.some((entry) => typeof entry !== 'string')) {
    throw new AiRunValidationError([{ field: 'context.relativePaths', message: 'Use at most 100 relative paths.' }]);
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new AiRunValidationError([{ field: 'context.relativePaths', message: 'Use only relative path strings.' }]);
    }
    paths.push(entry);
  }
  return [...new Set(paths)];
}

export function validateIdempotencyKey(value: string): string {
  if (!/^[\x21-\x7e]{8,200}$/u.test(value) || value.length > MAX_IDEMPOTENCY_LENGTH) {
    throw new AiRunIdempotencyRequiredError();
  }
  return value;
}

export function validateManifestHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new AiRunValidationError([{ field: 'manifestHash', message: 'Manifest hash must be a SHA-256 hexadecimal value.' }]);
  }
  return value;
}

export function validateDecision(value: unknown): 'approve' | 'reject' {
  if (value !== 'approve' && value !== 'reject') {
    throw new AiRunValidationError([{ field: 'decision', message: 'Decision must be approve or reject.' }]);
  }
  return value;
}

export const AI_RUN_LIMITS = {
  maxContextBytes: 256 * 1024,
  maxTotalBytes: 256 * 1024,
  maxMessages: 20,
  maxMessageBytes: 32 * 1024,
  maxTokenEstimate: 65_536
} as const;
