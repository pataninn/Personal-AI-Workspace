import type { DataSource, QueryRunner } from 'typeorm';

import { TypeOrmAiRunRepository } from '@/infrastructure/database/repositories/typeorm-ai-run-repository';
import type { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import type { TaskSuggestionCompletionWriter } from '@/infrastructure/database/repositories/task-suggestion-completion-writer';
import type { EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import { ProjectArchivedError } from '@/modules/conversations/domain/conversation-errors';
import { AssistantExecutionPolicyChangedError } from '@/modules/assistant-policy/domain/assistant-execution-errors';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const MANIFEST_HASH = 'a'.repeat(64);

const passThroughStorageAccounting = {
  runMutation: async <T>(_transaction: unknown, _ownerId: string, mutation: () => Promise<T>): Promise<T> => mutation()
} as unknown as TypeOrmStorageContentAccounting;

function withProjectRemovalBarrier(query: jest.Mock, removalPending = false): jest.Mock {
  return jest.fn(async (sql: string, parameters?: unknown[]): Promise<unknown> => {
    if (sql.includes('SELECT "project_id" FROM "ai_runs"')) return [{ project_id: PROJECT_ID }];
    if (sql.includes('FROM "projects"') && sql.includes('FOR UPDATE')) return [{ status: 'active', relative_root: null }];
    if (sql.includes('FROM "project_removal_jobs"')) return removalPending ? [{ project_id: PROJECT_ID }] : [];
    return query(sql, parameters);
  });
}

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
    project_id: PROJECT_ID,
    conversation_id: '44444444-4444-4444-8444-444444444444',
    request: 'Inspect',
    relative_root: '',
    storage_kind: 'legacy',
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
  it('moves interrupted persisted runs to manual review without changing confirmed transmission facts', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: RUN_ID }, { id: '33333333-3333-4333-8333-333333333333' }]);
    const runner = {
      connect: jest.fn(), startTransaction: jest.fn(), query, commitTransaction: jest.fn(), rollbackTransaction: jest.fn(), release: jest.fn(), isTransactionActive: false
    };
    const repository = new TypeOrmAiRunRepository({ createQueryRunner: () => runner } as unknown as DataSource);

    await expect(repository.recoverInterruptedRunsForReview()).resolves.toBe(2);

    const commandSql = String(query.mock.calls[0]?.[0]);
    expect(commandSql).toContain('UPDATE "sandbox_commands"');
    expect(commandSql).toContain('"decision"::text = \'policy_authorized\'');
    expect(commandSql).toContain("IN ('awaiting_approval', 'running', 'cancel_requested')");
    expect(query.mock.calls[0]?.[1]).toEqual(['The app restarted while this command was active. Review its saved status; the command was not resumed.']);
    const sql = String(query.mock.calls[1]?.[0]);
    expect(sql).toContain("'staging', 'ready', 'queued', 'running', 'waiting_approval', 'cancel_requested'");
    expect(sql).toContain("IN ('transmitted_confirmed', 'not_started_confirmed') THEN \"provider_transmission\"");
    expect(sql).toContain("'review_required'");
    expect(sql).toContain("'unknown'");
    expect(query.mock.calls[1]?.[1]).toEqual(['The app restarted while this run was active. Review its saved status; no work was resumed automatically.']);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('cancels an inactive principal run for internal cleanup without requiring user authorization', async () => {
    const stopped = row({ status: 'cancel_requested', phase: 'terminal', safe_message: 'This run stopped because account access is no longer active.' });
    const query = jest.fn().mockResolvedValue([stopped]);
    const repository = new TypeOrmAiRunRepository({ query } as unknown as DataSource);

    await expect(repository.stopForInactivePrincipal(OWNER_ID, RUN_ID)).resolves.toMatchObject({
      ownerId: OWNER_ID,
      status: 'cancel_requested',
      phase: 'terminal'
    });
    expect(query.mock.calls[0]?.[0]).toContain('SET "status" = \'cancel_requested\'');
    expect(query.mock.calls[0]?.[0]).toContain('AND "status" IN');
    expect(query.mock.calls[0]?.[1]).toEqual([OWNER_ID, RUN_ID]);
  });

  it('lists bounded project activity with owner/project scope, stable cursor ordering, and safe usage counts', async () => {
    const projectId = '33333333-3333-4333-8333-333333333333';
    const activityRow = {
      ...row({ provider_prompt_tokens: '14', provider_completion_tokens: null, provider_total_tokens: '14' }),
      activity_change_status: 'applied',
      activity_change_operation_count: '2',
      activity_change_applied_count: '1',
      activity_change_skipped_count: '1',
      activity_change_failed_count: '0',
      activity_change_backup_count: '1'
    };
    const query = jest.fn().mockResolvedValue([activityRow]);
    const repository = new TypeOrmAiRunRepository({ query } as unknown as DataSource);

    const result = await repository.listActivityForProjectOwner({
      ownerId: OWNER_ID,
      projectId,
      filter: 'attention',
      limit: 3,
      cursor: { createdAt: new Date('2026-09-15T12:30:00.000Z'), id: RUN_ID }
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).not.toMatch(/\bCOUNT\s*\(/iu);
    expect(query.mock.calls[0]?.[0]).toContain('r."owner_id" = $1 AND r."project_id" = $2');
    expect(query.mock.calls[0]?.[0]).toContain('r."created_at" DESC, r."id" ASC');
    expect(query.mock.calls[0]?.[1]).toEqual([OWNER_ID, projectId, new Date('2026-09-15T12:30:00.000Z'), RUN_ID, 4]);
    expect(result.records[0]?.run.providerUsage).toEqual({ promptTokens: 14, totalTokens: 14 });
    expect(result.records[0]?.changeSet).toEqual({ status: 'applied', operationCount: 2, appliedCount: 1, skippedCount: 1, failedCount: 0, backupCount: 1 });
  });

  it('stores provider usage with owner-scoped nullable count fields', async () => {
    const updated = row({ provider_prompt_tokens: '20', provider_completion_tokens: '4', provider_total_tokens: '24' });
    const query = jest.fn().mockResolvedValue([updated]);
    const repository = new TypeOrmAiRunRepository({ query } as unknown as DataSource);

    const result = await repository.recordProviderUsage(OWNER_ID, RUN_ID, { promptTokens: 20, completionTokens: 4, totalTokens: 24 });

    expect(query.mock.calls[0]?.[0]).toContain('COALESCE("provider_prompt_tokens", $1::bigint)');
    expect(query.mock.calls[0]?.[1]).toEqual([20, 4, 24, OWNER_ID, RUN_ID]);
    expect(result?.providerUsage).toEqual({ promptTokens: 20, completionTokens: 4, totalTokens: 24 });
  });

  it('records confirmed provider transmission with an enum cast and a narrow update', async () => {
    const updated = row({ status: 'running', provider_transmission: 'transmitted_confirmed' });
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: OWNER_ID }])
      .mockResolvedValueOnce([row({ status: 'running' })])
      .mockResolvedValueOnce([{ id: OWNER_ID }])
      .mockResolvedValueOnce([[updated], 1]);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined), startTransaction: jest.fn().mockResolvedValue(undefined), query,
      commitTransaction: jest.fn().mockResolvedValue(undefined), rollbackTransaction: jest.fn().mockResolvedValue(undefined), release: jest.fn().mockResolvedValue(undefined)
    } as unknown as QueryRunner;
    const repository = new TypeOrmAiRunRepository({ createQueryRunner: () => queryRunner } as unknown as DataSource);

    const result = await repository.recordProviderTransmission(OWNER_ID, RUN_ID, 'transmitted_confirmed');

    expect(result?.providerTransmission).toBe('transmitted_confirmed');
    expect(query.mock.calls[3]?.[0]).toContain('$1::"ai_run_provider_transmission"');
    expect(query.mock.calls[3]?.[0]).toContain('"status" IN');
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
      release: jest.fn().mockResolvedValue(undefined),
      isTransactionActive: true
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
    const businessQuery = jest.fn()
      .mockResolvedValueOnce([{ id: OWNER_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([{ id: OWNER_ID }])
      .mockResolvedValueOnce([[approved], 1]);
    const query = withProjectRemovalBarrier(businessQuery);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query,
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      isTransactionActive: true
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
    expect(query.mock.calls[0]?.[0]).toContain('FROM "users"');
    expect(query.mock.calls[1]?.[0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls.find(([sql]) => String(sql).includes('FROM "projects"') && String(sql).includes('FOR UPDATE'))).toBeDefined();
    expect(query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE "ai_runs"'))).toBeDefined();
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('transitions waiting approval back to running', async () => {
    const waiting = row({ status: 'waiting_approval', phase: 'inference' });
    const running = row({ status: 'running', phase: 'inference', safe_message: 'Assistant is working.' });
    const businessQuery = jest.fn()
      .mockResolvedValueOnce([{ id: OWNER_ID }])
      .mockResolvedValueOnce([waiting])
      .mockResolvedValueOnce([{ id: OWNER_ID }])
      .mockResolvedValueOnce([running]);
    const query = withProjectRemovalBarrier(businessQuery);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query,
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      isTransactionActive: true
    } as unknown as QueryRunner;
    const dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as unknown as DataSource;
    const repository = new TypeOrmAiRunRepository(dataSource);

    const result = await repository.markRunning(OWNER_ID, RUN_ID);

    expect(result?.status).toBe('running');
    expect(query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE "ai_runs"'))?.[0]).toContain("'queued', 'waiting_approval'");
  });

  it('rolls back start when the bound workspace policy was revoked before admission', async () => {
    const bound = row({ decision: 'policy_authorized', policy_revision: '4', status: 'ready', phase: 'runtime' });
    const businessQuery = jest.fn()
      .mockResolvedValueOnce([{ id: OWNER_ID }])
      .mockResolvedValueOnce([bound])
      .mockResolvedValueOnce([{ id: OWNER_ID }])
      .mockResolvedValueOnce([{ policy_profile: 'workspace_in_scope_v1', provider_profile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b', enabled: false, revoked_at: new Date(), revision: '5' }]);
    const query = withProjectRemovalBarrier(businessQuery);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined), startTransaction: jest.fn().mockResolvedValue(undefined), query,
      commitTransaction: jest.fn().mockResolvedValue(undefined), rollbackTransaction: jest.fn().mockResolvedValue(undefined), release: jest.fn().mockResolvedValue(undefined)
    } as unknown as QueryRunner;
    const repository = new TypeOrmAiRunRepository({ createQueryRunner: () => queryRunner } as unknown as DataSource);

    await expect(repository.beginStart({ ownerId: OWNER_ID, runId: RUN_ID, idempotencyKey: 'start-key', requestFingerprint: 'f'.repeat(64) }))
      .rejects.toBeInstanceOf(AssistantExecutionPolicyChangedError);

    const policyRead = query.mock.calls.find(([sql]) => String(sql).includes('FROM "assistant_scope_policies"'));
    expect(policyRead?.[0]).toContain('FOR SHARE');
    expect(policyRead?.[1]).toEqual([OWNER_ID, PROJECT_ID]);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE "ai_runs"'))).toBe(false);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('persists task suggestions inside the existing run completion transaction', async () => {
    const running = row({ status: 'running', phase: 'inference', decision: 'approved' });
    const done = row({ status: 'succeeded', phase: 'terminal', decision: 'approved' });
    const businessQuery = jest.fn()
      .mockResolvedValueOnce([running])
      .mockResolvedValueOnce([{ id: OWNER_ID }])
      .mockResolvedValueOnce([[done], 1]);
    const query = withProjectRemovalBarrier(businessQuery);
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
    const repository = new TypeOrmAiRunRepository({ createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as unknown as DataSource, writer, passThroughStorageAccounting);
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
    const businessQuery = jest.fn()
      .mockResolvedValueOnce([running])
      .mockResolvedValueOnce([{ id: OWNER_ID }]);
    const query = withProjectRemovalBarrier(businessQuery);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query,
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      isTransactionActive: true
    } as unknown as QueryRunner;
    const writer = { persistForRunCompletion: jest.fn().mockRejectedValue(new Error('write failed')) } as TaskSuggestionCompletionWriter;
    const repository = new TypeOrmAiRunRepository({ createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as unknown as DataSource, writer, passThroughStorageAccounting);

    await expect(repository.completeRun({ ownerId: OWNER_ID, runId: RUN_ID, status: 'succeeded', safeMessage: 'Complete.', taskSuggestions: [{ title: 'Update setup notes', details: null }] })).rejects.toThrow('write failed');
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(query.mock.calls.every(([sql]) => !String(sql).startsWith('UPDATE "ai_runs"'))).toBe(true);
  });

  it('suppresses assistant output and task suggestions when account disable wins before completion', async () => {
    const running = row({ status: 'running', phase: 'inference', decision: 'approved' });
    const cancelled = row({ ...running, status: 'cancel_requested', phase: 'terminal', safe_message: 'This run stopped because account access is no longer active.' });
    const query = jest.fn().mockResolvedValue([cancelled]);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined), startTransaction: jest.fn().mockResolvedValue(undefined), query,
      commitTransaction: jest.fn().mockResolvedValue(undefined), rollbackTransaction: jest.fn().mockResolvedValue(undefined), release: jest.fn().mockResolvedValue(undefined), isTransactionActive: true
    } as unknown as QueryRunner;
    const writer = { persistForRunCompletion: jest.fn() } as unknown as TaskSuggestionCompletionWriter;
    const dataSource = { createQueryRunner: () => queryRunner, query } as unknown as DataSource;
    const inactiveAccounting = {
      runMutation: async <T>(): Promise<T> => { throw new UnauthenticatedError(); }
    } as unknown as TypeOrmStorageContentAccounting;
    const repository = new TypeOrmAiRunRepository(dataSource, writer, inactiveAccounting);

    const result = await repository.completeRun({
      ownerId: OWNER_ID,
      runId: RUN_ID,
      status: 'succeeded',
      safeMessage: 'Assistant response complete.',
      assistantText: 'private late assistant response',
      taskSuggestions: [{ title: 'late suggestion', details: null }]
    });

    expect(result?.status).toBe('cancel_requested');
    expect(writer.persistForRunCompletion).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO "messages"'))).toBe(false);
    expect(query.mock.calls[0]?.[0]).toContain("SET \"status\" = 'cancel_requested'");
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('suppresses late assistant output after a project removal job is committed', async () => {
    const running = row({ status: 'running', phase: 'inference', decision: 'approved' });
    const businessQuery = jest.fn().mockResolvedValue([running]);
    const query = withProjectRemovalBarrier(businessQuery, true);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined), startTransaction: jest.fn().mockResolvedValue(undefined), query,
      commitTransaction: jest.fn().mockResolvedValue(undefined), rollbackTransaction: jest.fn().mockResolvedValue(undefined), release: jest.fn().mockResolvedValue(undefined), isTransactionActive: true
    } as unknown as QueryRunner;
    const writer = { persistForRunCompletion: jest.fn() } as unknown as TaskSuggestionCompletionWriter;
    const repository = new TypeOrmAiRunRepository({ createQueryRunner: () => queryRunner } as unknown as DataSource, writer, passThroughStorageAccounting);

    await expect(repository.completeRun({
      ownerId: OWNER_ID,
      runId: RUN_ID,
      status: 'succeeded',
      safeMessage: 'Assistant response complete.',
      assistantText: 'late private response',
      taskSuggestions: [{ title: 'late suggestion', details: null }]
    })).rejects.toBeInstanceOf(ProjectArchivedError);

    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO "messages"'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE "ai_runs"'))).toBe(false);
    expect(writer.persistForRunCompletion).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});
