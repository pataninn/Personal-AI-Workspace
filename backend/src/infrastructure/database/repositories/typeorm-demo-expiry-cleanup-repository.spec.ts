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
