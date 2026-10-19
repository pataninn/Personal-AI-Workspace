import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmProposedChangeSetRepository } from '@/infrastructure/database/repositories/typeorm-change-set-repository';
import type { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';

const passThroughStorageAccounting = {
  runMutation: async <T>(_transaction: unknown, _ownerId: string, mutation: () => Promise<T>): Promise<T> => mutation()
} as unknown as TypeOrmStorageContentAccounting;

describe('TypeOrmProposedChangeSetRepository', () => {
  it('lists bounded owner and project scoped file history without loading raw JSON content or counting rows', async () => {
    const query = jest.fn(async (_sql: string, _parameters?: unknown[]) => []);
    const repository = new TypeOrmProposedChangeSetRepository({ query } as unknown as DataSource);
    await repository.listFileHistoryForProjectOwner({ ownerId: 'owner', projectId: 'project', path: 'src/app.ts', outcome: 'all', limit: 20 });
    const sql = query.mock.calls[0]?.[0] as string;
    expect(query).toHaveBeenCalledTimes(1);
    expect(sql).toContain('change_set."owner_id" = $1 AND change_set."project_id" = $2');
    expect(sql).toContain('change_set."operation_paths" @> ARRAY[$3]::text[]');
    expect(sql).toContain('jsonb_array_elements(change_set."operations") WITH ORDINALITY');
    expect(sql).toContain("WHEN change_set.\"status\" IN ('stale', 'needs_manual_review') THEN 'unknown'");
    expect(sql).toContain("$4::text = 'all' OR result.item->>'status' = 'applied'");
    expect(sql).not.toContain("change_set.\"status\" = 'applied' AND result.item->>'status'");
    expect(sql).toContain("ELSE 'not_created'");
    expect(sql).toContain('LIMIT $8');
    expect(sql).not.toMatch(/\bCOUNT\s*\(/iu);
    expect(sql).not.toMatch(/SELECT\s+change_set\."operations"/iu);
    expect(sql).not.toMatch(/SELECT\s+change_set\."result"/iu);
  });

  it('maps PostgreSQL UPDATE RETURNING rows before applying a confirmed decision', async () => {
    const ownerId = '11111111-1111-4111-8111-111111111111';
    const runId = '22222222-2222-4222-8222-222222222222';
    const pending = {
      id: '33333333-3333-4333-8333-333333333333', owner_id: ownerId,
      project_id: '44444444-4444-4444-8444-444444444444', run_id: runId,
      proposal_hash: 'a'.repeat(64), status: 'awaiting_approval', decision: 'pending',
      operations: [], total_size_bytes: 0, total_line_count: 0,
      preview_limit_bytes: 8192, preview_limit_lines: 200, fake_runtime: false,
      backup_checkpoints: [], result: null, decision_idempotency_key: null,
      decision_fingerprint: null, safe_message: 'Review.',
      created_at: new Date(), updated_at: new Date()
    };
    const updated = { ...pending, status: 'applying', decision: 'approved' };
    const responses = [
      [{ id: ownerId }],
      [pending],
      [[updated], 1]
    ];
    const query = jest.fn(async (sql: string, _parameters?: unknown[]): Promise<unknown> => {
      if (sql.includes('FROM "projects"') && sql.includes('FOR UPDATE')) return [{ status: 'active', relative_root: null }];
      if (sql.includes('FROM "project_removal_jobs"')) return [];
      return responses.shift() ?? [];
    });
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query,
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined)
    } as unknown as QueryRunner;
    const repository = new TypeOrmProposedChangeSetRepository({ createQueryRunner: () => queryRunner } as unknown as DataSource, passThroughStorageAccounting);

    const result = await repository.recordDecision({
      ownerId, runId, proposalHash: pending.proposal_hash, decision: 'approve',
      idempotencyKey: 'decision-key', requestFingerprint: 'b'.repeat(64)
    });

    expect(result.resource.ownerId).toBe(ownerId);
    expect(result.resource.projectId).toBe(pending.project_id);
    expect(result.resource.status).toBe('applying');
    expect(query.mock.calls[0]?.[0]).toContain('"expires_at" > now()) FOR SHARE');
    expect(query.mock.calls.find(([sql]) => String(sql).includes('FROM "project_removal_jobs"'))?.[1]).toEqual([ownerId, pending.project_id]);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });
});
