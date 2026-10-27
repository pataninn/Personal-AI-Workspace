import { describe, expect, it } from 'vitest';

import { ApiClientError } from '@/shared/api';
import { normalizeProposedChangeSet } from '@/entities/ai-run/api/change-set-api';

const RUN_ID = '77777777-7777-4777-8777-000000000001';
const PROJECT_ID = '88888888-8888-4888-8888-000000000001';
const HASH = 'a'.repeat(64);
const operation = {
  operationId: '99999999-9999-4999-8999-000000000001',
  operation: 'edit',
  path: 'src/app.ts',
  summary: 'Update a bounded source file',
  sourcePresent: true,
  destinationPresent: true,
  backupRequired: true,
  sizeBytes: 20,
  lineCount: 2,
  reviewable: true,
  preview: { text: '- old\n+ new', limited: false, kind: 'diff' }
} as const;

function changeSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    status: 'awaiting_approval',
    decision: 'pending',
    proposalHash: HASH,
    fakeRuntime: true,
    totalSizeBytes: 20,
    totalLineCount: 2,
    previewLimitBytes: 8192,
    previewLimitLines: 200,
    safeMessage: 'Review the proposed changes.',
    operations: [operation],
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    ...overrides
  };
}

describe('proposed change-set API normalizer', () => {
  it('preserves policy authorization as distinct from human approval', () => {
    const result = normalizeProposedChangeSet(changeSet({ status: 'applied', decision: 'policy_authorized' }));
    expect(result.decision).toBe('policy_authorized');
  });

  it('keeps safe bounded operation metadata and preview text', () => {
    const result = normalizeProposedChangeSet(changeSet());
    expect(result).toMatchObject({ runId: RUN_ID, projectId: PROJECT_ID, status: 'awaiting_approval', fakeRuntime: true });
    expect(result.operations[0]).toMatchObject({ path: 'src/app.ts', backupRequired: true });
    expect(result.operations[0]?.preview?.text).toContain('+ new');
  });

  it('rejects absolute or traversal paths and oversized/control previews', () => {
    expect(() => normalizeProposedChangeSet(changeSet({ operations: [{ ...operation, path: 'C:\\Users\\patan\\secret.ts' }] }))).toThrow(ApiClientError);
    expect(() => normalizeProposedChangeSet(changeSet({ operations: [{ ...operation, path: '../outside.ts' }] }))).toThrow(ApiClientError);
    expect(() => normalizeProposedChangeSet(changeSet({ operations: [{ ...operation, preview: { text: 'x'.repeat(9000), limited: false, kind: 'diff' } }] }))).toThrow(ApiClientError);
  });

  it('normalizes an authoritative persisted result without raw content', () => {
    const result = normalizeProposedChangeSet(changeSet({
      status: 'applied',
      decision: 'approved',
      result: { persisted: true, appliedCount: 1, skippedCount: 0, failedCount: 0, backupCount: 1, operations: [{ operationId: operation.operationId, operation: 'edit', path: operation.path, status: 'applied', backup: 'created', safeMessage: 'Edited after a recovery backup.' }] }
    }));
    expect(result.result).toMatchObject({ persisted: true, appliedCount: 1, backupCount: 1 });
    expect(result.result?.operations[0]).not.toHaveProperty('content');
  });
});
