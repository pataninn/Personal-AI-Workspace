import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmAiRunRepository } from '@/infrastructure/database/repositories/typeorm-ai-run-repository';
import type { TaskSuggestionCompletionWriter } from '@/infrastructure/database/repositories/task-suggestion-completion-writer';
import type { EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const MANIFEST_HASH = 'a'.repeat(64);

function manifest(): EgressManifest {
  return {
    manifestHash: MANIFEST_HASH,
    provider: 'NVIDIA hosted NIM',
    providerProfile: 'nvidia-hosted-nim',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    categories: ['Request'],
    files: [],
    requestBytes: 8,
    messageBytes: 0,
    messageCount: 0,
    messageHash: 'b'.repeat(64),
    byteEstimate: 8,
    tokenEstimate: 2,
    excludedItemCount: 0,
    omittedItemCount: 0,
    omissionSummary: 'No selected items were excluded or omitted.',
    bestEffortSecretDetection: true
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date('2026-09-16T00:00:00.000Z');
  return {
    id: RUN_ID,
    owner_id: OWNER_ID,
    project_id: '33333333-3333-4333-8333-333333333333',
    conversation_id: '44444444-4444-4444-8444-444444444444',
    request: 'Inspect',
    relative_root: '',
    requested_paths: [],
    manifest: manifest(),
    manifest_hash: MANIFEST_HASH,
    manifest_invalidated: false,
    status: 'pending_approval',
    phase: 'decision',
    decision: 'pending',
    cleanup: 'not_started',
    provider_transmission: 'not_started_confirmed',
    staging_item_count: 0,
    runtime_kind: null,
    sandbox_ready: false,
    create_idempotency_key: 'create-key',
    request_fingerprint: 'c'.repeat(64),
    decision_idempotency_key: null,
    decision_fingerprint: null,
    safe_message: 'Review the provider disclosure before continuing.',
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

describe('TypeOrmAiRunRepository', () => {
  it('records confirmed provider transmission with an enum cast and a narrow update', async () => {
    const updated = row({ status: 'running', provider_transmission: 'transmitted_confirmed' });
    const query = jest.fn().mockResolvedValue([[updated], 1]);
    const repository = new TypeOrmAiRunRepository({ query } as unknown as DataSource);

    const result = await repository.recordProviderTransmission(OWNER_ID, RUN_ID, 'transmitted_confirmed');

    expect(result?.providerTransmission).toBe('transmitted_confirmed');
    expect(query.mock.calls[0]?.[0]).toContain('$1::"ai_run_provider_transmission"');
    expect(query.mock.calls[0]?.[0]).toContain('"status" IN');
  });

  it('preserves confirmed transmission when a completed provider response needs review', async () => {
    const reviewed = row({ status: 'review_required', phase: 'review', provider_transmission: 'transmitted_confirmed' });
    const query = jest.fn().mockResolvedValue([[reviewed], 1]);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query,
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined)
    } as unknown as QueryRunner;
    const repository = new TypeOrmAiRunRepository({ createQueryRunner: () => queryRunner } as unknown as DataSource);

    const result = await repository.markReviewRequired(OWNER_ID, RUN_ID, 'The suggestion write needs review.');

    expect(result?.status).toBe('review_required');
    expect(result?.providerTransmission).toBe('transmitted_confirmed');
    expect(query.mock.calls[0]?.[0]).toContain('CASE WHEN "provider_transmission" = \'transmitted_confirmed\'');
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('commits approval checkpoint before returning control to staging', async () => {
    const pending = row();
    const approved = row({
      status: 'staging',
      phase: 'staging',
      decision: 'approved',
      decision_idempotency_key: 'decision-key',
      decision_fingerprint: 'd'.repeat(64),
      safe_message: 'Preparing a private run environment.'
    });
    const query = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([[approved], 1]);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query,
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined)
    } as unknown as QueryRunner;
    const dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as unknown as DataSource;
    const repository = new TypeOrmAiRunRepository(dataSource);

    const result = await repository.recordDecision({
      ownerId: OWNER_ID,
      runId: RUN_ID,
      manifestHash: MANIFEST_HASH,
      decision: 'approve',
      idempotencyKey: 'decision-key',
      requestFingerprint: 'd'.repeat(64)
    });

    expect(result.resource.status).toBe('staging');
    expect(result.resource.decision).toBe('approved');
    expect(query.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[1]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls[2]?.[0]).toContain('UPDATE "ai_runs"');
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('transitions waiting approval back to running', async () => {
    const waiting = row({ status: 'waiting_approval', phase: 'inference' });
    const running = row({ status: 'running', phase: 'inference', safe_message: 'Assistant is working.' });
    const query = jest.fn()
      .mockResolvedValueOnce([waiting])
      .mockResolvedValueOnce([running]);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query,
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined)
    } as unknown as QueryRunner;
    const dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as unknown as DataSource;
    const repository = new TypeOrmAiRunRepository(dataSource);

    const result = await repository.markRunning(OWNER_ID, RUN_ID);

    expect(result?.status).toBe('running');
    expect(query.mock.calls[1]?.[0]).toContain("'queued', 'waiting_approval'");
  });

  it('persists task suggestions inside the existing run completion transaction', async () => {
    const running = row({ status: 'running', phase: 'inference', decision: 'approved' });
    const done = row({ status: 'succeeded', phase: 'terminal', decision: 'approved' });
    const query = jest.fn().mockResolvedValueOnce([running]).mockResolvedValueOnce([[done], 1]);
    const commitTransaction = jest.fn().mockResolvedValue(undefined);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query,
      commitTransaction,
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined)
    } as unknown as QueryRunner;
    const persistForRunCompletion = jest.fn().mockResolvedValue(undefined);
    const writer = { persistForRunCompletion } as TaskSuggestionCompletionWriter;
    const repository = new TypeOrmAiRunRepository({ createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as unknown as DataSource, writer);
    const drafts = [{ title: 'Update setup notes', details: null }];

    const result = await repository.completeRun({ ownerId: OWNER_ID, runId: RUN_ID, status: 'succeeded', safeMessage: 'Complete.', taskSuggestions: drafts });

    expect(result?.status).toBe('succeeded');
    expect(persistForRunCompletion).toHaveBeenCalledWith(queryRunner, {
      runId: RUN_ID,
      ownerId: OWNER_ID,
      projectId: running.project_id,
      conversationId: running.conversation_id
    }, drafts);
    expect(persistForRunCompletion.mock.invocationCallOrder[0]).toBeLessThan(commitTransaction.mock.invocationCallOrder[0]!);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('rolls back run completion when task suggestion persistence fails', async () => {
    const running = row({ status: 'running', phase: 'inference', decision: 'approved' });
    const query = jest.fn().mockResolvedValueOnce([running]);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query,
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined)
    } as unknown as QueryRunner;
    const writer = { persistForRunCompletion: jest.fn().mockRejectedValue(new Error('write failed')) } as TaskSuggestionCompletionWriter;
    const repository = new TypeOrmAiRunRepository({ createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as unknown as DataSource, writer);

    await expect(repository.completeRun({ ownerId: OWNER_ID, runId: RUN_ID, status: 'succeeded', safeMessage: 'Complete.', taskSuggestions: [{ title: 'Update setup notes', details: null }] })).rejects.toThrow('write failed');
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(query.mock.calls.every(([sql]) => !String(sql).startsWith('UPDATE "ai_runs"'))).toBe(true);
  });
});
