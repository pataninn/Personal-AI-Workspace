import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmProposedChangeSetRepository } from '@/infrastructure/database/repositories/typeorm-change-set-repository';

describe('TypeOrmProposedChangeSetRepository', () => {
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
    const query = jest.fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([{ status: 'active' }])
      .mockResolvedValueOnce([[updated], 1]);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query,
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined)
    } as unknown as QueryRunner;
    const repository = new TypeOrmProposedChangeSetRepository({ createQueryRunner: () => queryRunner } as unknown as DataSource);

    const result = await repository.recordDecision({
      ownerId, runId, proposalHash: pending.proposal_hash, decision: 'approve',
      idempotencyKey: 'decision-key', requestFingerprint: 'b'.repeat(64)
    });

    expect(result.resource.ownerId).toBe(ownerId);
    expect(result.resource.projectId).toBe(pending.project_id);
    expect(result.resource.status).toBe('applying');
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });
});
