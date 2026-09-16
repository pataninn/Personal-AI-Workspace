import { redactEgressText } from '@/shared/egress/redaction';

export const MAX_ASSISTANT_OUTPUT_BYTES = 64 * 1024;
export const MAX_ASSISTANT_DELTA_BYTES = 4 * 1024;
export const ASSISTANT_OUTPUT_LIMIT_MESSAGE = 'The assistant response exceeded the 64 KiB safety limit. The partial result was saved for review and was not marked complete.';

export function sanitizeAssistantText(value: string, maxBytes = MAX_ASSISTANT_OUTPUT_BYTES): string {
  return truncateUtf8(normalizeAssistantText(value), maxBytes);
}

export function truncateAssistantDelta(value: string): string {
  return sanitizeAssistantText(value, MAX_ASSISTANT_DELTA_BYTES);
}

export function assistantTextExceedsLimit(value: string, maxBytes = MAX_ASSISTANT_OUTPUT_BYTES): boolean {
  return Buffer.byteLength(normalizeAssistantText(value), 'utf8') > maxBytes;
}

function normalizeAssistantText(value: string): string {
  return redactEgressText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}
