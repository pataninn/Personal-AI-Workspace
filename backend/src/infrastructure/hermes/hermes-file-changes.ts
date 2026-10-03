import { isRecord } from '@/infrastructure/hermes/hermes-bridge-client';
import { hash, type SnapshotFile } from '@/infrastructure/hermes/approved-context-reader';
import type { RuntimeChangeProposal } from '@/modules/ai-runs/domain/change-types';
import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';

/** Converts verified sandbox bytes into the existing application change contract. */
export function collectHermesChanges(value: unknown, before: readonly SnapshotFile[]): readonly RuntimeChangeProposal[] {
  if (!Array.isArray(value) || value.length > 100) throw new AiRunRuntimeUnavailableError();
  const originals = new Map(before.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const changes: RuntimeChangeProposal[] = [];
  let totalBytes = 0;
  for (const file of value) {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.content !== 'string' || typeof file.sha256 !== 'string' || seen.has(file.path)) throw new AiRunRuntimeUnavailableError();
    seen.add(file.path);
    const bytes = Buffer.from(file.content, 'base64');
    totalBytes += bytes.length;
    if (bytes.length > 256 * 1024 || totalBytes > 512 * 1024 || hash(bytes) !== file.sha256) throw new AiRunRuntimeUnavailableError();
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const original = originals.get(file.path);
    if (original?.sha256 !== file.sha256) changes.push({ operation: original ? 'edit' : 'create', path: file.path, content, summary: 'Prepare Hermes project changes', ...(original ? { expectedSourceHash: original.sourceHash } : {}) });
  }
  for (const file of before) if (!seen.has(file.path)) changes.push({ operation: 'delete', path: file.path, expectedSourceHash: file.sourceHash, summary: 'Prepare Hermes file deletion' });
  return changes;
}
