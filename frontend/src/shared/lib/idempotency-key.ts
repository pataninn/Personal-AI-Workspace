export function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `intent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
