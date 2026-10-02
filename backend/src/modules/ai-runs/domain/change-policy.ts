export const CHANGE_SET_LIMITS = {
  maxOperations: 100,
  maxContentBytes: 256 * 1024,
  maxTotalContentBytes: 2 * 1024 * 1024,
  maxPreviewBytes: 8 * 1024,
  maxPreviewLines: 200,
  maxTotalPreviewBytes: 64 * 1024,
  maxPathLength: 2048,
  maxSummaryLength: 240
} as const;

export const DESTRUCTIVE_OPERATIONS = new Set(['edit', 'overwrite', 'delete']);

export function isDestructiveOperation(operation: string, destinationPresent = false): boolean {
  return DESTRUCTIVE_OPERATIONS.has(operation) || (operation === 'rename' && destinationPresent);
}
