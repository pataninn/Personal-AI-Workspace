const RECEIPT_POINTER_PREFIX = 'personal-ai:task-action-receipt:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Stores only an opaque receipt ID; receipt state is always reloaded from the server. */
export function readTaskReceiptPointer(ownerId: string, taskId: string): string | null {
  try {
    const key = receiptKey(ownerId, taskId);
    const value = globalThis.sessionStorage.getItem(key);
    if (value === null) return null;
    if (UUID_PATTERN.test(value)) return value;
    globalThis.sessionStorage.removeItem(key);
    return null;
  } catch {
    return null;
  }
}

export function saveTaskReceiptPointer(ownerId: string, taskId: string, actionId: string): void {
  if (!UUID_PATTERN.test(actionId)) return;
  try {
    globalThis.sessionStorage.setItem(receiptKey(ownerId, taskId), actionId);
  } catch {
    // Receipt display remains available for this page view when session storage is blocked.
  }
}

export function clearTaskReceiptPointer(ownerId: string, taskId: string): void {
  try {
    globalThis.sessionStorage.removeItem(receiptKey(ownerId, taskId));
  } catch {
    // The pointer is optional; server authorization and receipt state are independent of storage.
  }
}

function receiptKey(ownerId: string, taskId: string): string {
  return `${RECEIPT_POINTER_PREFIX}${encodeURIComponent(ownerId)}:${encodeURIComponent(taskId)}`;
}
