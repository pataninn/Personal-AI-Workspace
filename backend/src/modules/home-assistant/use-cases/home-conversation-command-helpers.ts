import { createHash } from 'node:crypto';

import { HomeConversationInputInvalidError } from '@/modules/home-assistant/domain/home-conversation-errors';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/u;

/** Validates the shared bounded request identity used by Home conversation commands. */
export function assertHomeIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value)) throw new HomeConversationInputInvalidError('A valid Idempotency-Key header is required.');
}

/** Hashes a canonical JSON request so matching retries cannot duplicate persisted work. */
export function homeRequestFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
