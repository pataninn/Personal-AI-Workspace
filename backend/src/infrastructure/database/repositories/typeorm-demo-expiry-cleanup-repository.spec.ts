import type { DataSource, EntityManager } from 'typeorm';

import { TypeOrmDemoExpiryCleanupRepository } from '@/infrastructure/database/repositories/typeorm-demo-expiry-cleanup-repository';
import type { IProjectRecoveryCleaner } from '@/modules/projects/repositories/project-removal-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import type { IStorageRootMappingRepository } from '@/modules/storage-quotas/repositories/storage-root-mapping-repository';
import type { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import type { DemoExpiryCancellationPort } from '@/modules/demo/domain/demo-expiry-cleanup-types';

const OWNER_ID = 'f3330000-0000-4000-8000-000000000101';
const ADMISSION_ID = 'f3330000-0000-4000-8000-000000000201';
const GENERATION = 'f3330000-0000-4000-8000-000000000301';
const LEASE = 'f3330000-0000-4000-8000-000000000401';

function unused<T>(): T { return {} as T; }

describe('TypeOrmDemoExpiryCleanupRepository', () => {
  it.each(['fenced', 'finalizing'])('discovers interactive turns absent from a legacy %s manifest and retries uncertain cleanup before purge', async (phase) => {
    const turnId = 'f3330000-0000-4000-8000-000000000501';
    const conversationId = 'f3330000-0000-4000-8000-000000000601';
    let turnStatus = 'cancel_requested';
    const job = { admission_id: ADMISSION_ID, owner_id: OWNER_ID, generation: GENERATION, phase,
      manifest: { ownerId: OWNER_ID, projectIds: [], runs: [], commands: [], reservations: [], roots: [], copy: null },
      lease_token: LEASE, attempts: 1 };
    const query = jest.fn(async (statement: string, values?: readonly unknown[]) => {
      if (statement.includes('SELECT a."id", a."owner_id"')) return [];
      if (statement.includes('FROM "demo_expiry_cleanups" c JOIN "demo_admissions" a')) return [job];
      if (statement.includes('RETURNING "admission_id","generation","phase","manifest","lease_token","attempts"')) return [job];
      if (statement.includes('SELECT "id","conversation_id" FROM "home_turns"')) {
        expect(values).toEqual([OWNER_ID]);
        return [{ id: turnId, conversation_id: conversationId }];
      }
      if (statement.includes('UPDATE "home_turns"')) { turnStatus = String(values?.[2]); return []; }
      if (statement.includes('AS "uncertain_home_turn"')) return [{ uncertain_home_turn: turnStatus === 'unknown', active_credit_reservation: true }];
      if (statement.includes('RETURNING "admission_id" AS "id"')) return [{ id: ADMISSION_ID }];
      return [];
    });
    const dataSource = { query, transaction: async (action: (manager: EntityManager) => Promise<unknown>) => action({ query } as unknown as EntityManager) } as unknown as DataSource;
    const workspace = { removeManagedProjectRoot: jest.fn() };
    const quota = { purgeDemoOwnedReferences: jest.fn() };
    const repository = new TypeOrmDemoExpiryCleanupRepository(dataSource, workspace as unknown as IWorkspaceBoundary,
      unused<IProjectRecoveryCleaner>(), unused<IStorageRootMappingRepository>(), quota as unknown as TypeOrmStorageQuotaRepository);
    const cancelHomeTurn = jest.fn().mockResolvedValueOnce({ status: 'unknown' }).mockResolvedValueOnce({ status: 'cancelled' });
    const cancellation = { cancelHomeTurn, cancelRun: jest.fn(), cancelCommand: jest.fn(), cancelAutomationTurn: jest.fn() };

    await expect(repository.runBatch(cancellation, 1)).resolves.toBe(0);
    expect(turnStatus).toBe('unknown');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('"next_attempt_at"'), [ADMISSION_ID, GENERATION, LEASE, 'unknown_effect']);
    await expect(repository.runBatch(cancellation, 1)).resolves.toBe(0);
    expect(turnStatus).toBe('cancelled');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('"next_attempt_at"'), [ADMISSION_ID, GENERATION, LEASE, 'busy']);
    expect(cancelHomeTurn).toHaveBeenNthCalledWith(2, { ownerId: OWNER_ID, conversationId, turnId });
    expect(cancellation.cancelAutomationTurn).not.toHaveBeenCalled();
    expect(quota.purgeDemoOwnedReferences).not.toHaveBeenCalled();
    expect(workspace.removeManagedProjectRoot).not.toHaveBeenCalled();
  });

  it('keeps a cleanup pending when a managed-root creation receipt is unresolved', async () => {
    const job = {
      admission_id: ADMISSION_ID, owner_id: OWNER_ID, generation: GENERATION, phase: 'fenced' as const,
      manifest: { ownerId: OWNER_ID, projectIds: [], runs: [], commands: [], reservations: [], roots: [], copy: null },
      lease_token: LEASE, attempts: 1
    };
    const sql: string[] = [];
    const parameters: unknown[][] = [];
    const query = jest.fn(async (statement: string, values?: readonly unknown[]) => {
      sql.push(statement);
      parameters.push([...(values ?? [])]);
      if (statement.includes('SELECT a."id", a."owner_id"')) return [];
      if (statement.includes('FROM "demo_expiry_cleanups" c JOIN "demo_admissions" a')) return [{ ...job, lease_token: undefined }];
      if (statement.includes('RETURNING "admission_id","generation","phase","manifest","lease_token","attempts"')) return [job];
      if (statement.includes('SELECT "id" FROM "ai_runs"')) return [];
      if (statement.includes('SELECT "id","run_id" FROM "sandbox_commands"')) return [];
      if (statement.includes('AS "unresolved_root_effect"')) return [{
        active_run: false, uncertain_provider: false, active_command: false,
        unresolved_reservation: false, unresolved_root_effect: true, removal_job: false
      }];
      if (statement.includes('RETURNING "admission_id" AS "id"')) return [{ id: ADMISSION_ID }];
      return [];
    });
    const dataSource = {
      query,
      transaction: jest.fn(async (action: (manager: EntityManager) => Promise<unknown>) => await action({ query } as unknown as EntityManager))
    } as unknown as DataSource;
    const workspace = { removeManagedProjectRoot: jest.fn(), inspectManagedNamespace: jest.fn() } as unknown as IWorkspaceBoundary;
    const recovery = { purge: jest.fn() } as unknown as IProjectRecoveryCleaner;
    const roots = { listMappings: jest.fn() } as unknown as IStorageRootMappingRepository;
    const quota = unused<TypeOrmStorageQuotaRepository>();
    const repository = new TypeOrmDemoExpiryCleanupRepository(dataSource, workspace, recovery, roots, quota);
    const cancellation: DemoExpiryCancellationPort = { cancelRun: jest.fn(), cancelCommand: jest.fn(), cancelAutomationTurn: jest.fn() };

    await expect(repository.runBatch(cancellation, 2)).resolves.toBe(0);

    expect(sql.some((statement) => statement.includes('SKIP LOCKED'))).toBe(true);
    expect(parameters).toContainEqual([ADMISSION_ID, GENERATION, LEASE, 'unknown_effect']);
    expect(workspace.removeManagedProjectRoot).not.toHaveBeenCalled();
    expect(recovery.purge).not.toHaveBeenCalled();
    expect(roots.listMappings).not.toHaveBeenCalled();
  });
});
