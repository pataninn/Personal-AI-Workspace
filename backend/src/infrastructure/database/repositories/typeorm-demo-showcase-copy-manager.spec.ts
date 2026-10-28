import type { DataSource } from 'typeorm';

import { TypeOrmDemoShowcaseCopyManager } from '@/infrastructure/database/repositories/typeorm-demo-showcase-copy-manager';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import type { IShowcaseRepository } from '@/modules/showcases/domain/showcase-types';
import type { TypeOrmProjectFileAccess } from '@/infrastructure/database/repositories/typeorm-project-file-access';
import type { ProjectFileGateway } from '@/infrastructure/workspace/project-file-gateway';
import type { StorageQuotaFileMutation } from '@/infrastructure/workspace/storage-quota-file-mutation';
import type { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import type { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';

const OWNER_ID = 'd3330000-0000-4000-8000-000000000101';
const PROJECT_ID = 'd3330000-0000-4000-8000-000000000401';

function unusedDependency<T>(): T {
  // The tested read method does not touch these constructor dependencies.
  return {} as T;
}

describe('TypeOrmDemoShowcaseCopyManager status projection', () => {
  it('hides the target project ID until the owner copy is fully ready', async () => {
    const query = jest.fn<Promise<unknown>, unknown[]>()
      .mockResolvedValueOnce([{
        target_project_id: PROJECT_ID, state: 'pending', retry_allowed: true, workspace_mode: null, file_access: null
      }])
      .mockResolvedValueOnce([{
        target_project_id: PROJECT_ID, state: 'ready', retry_allowed: false, workspace_mode: 'planning', file_access: false
      }]);
    // This test exercises only the read projection, so other adapter ports are intentionally inert.
    const dataSource = { query } as unknown as DataSource;
    const manager = new TypeOrmDemoShowcaseCopyManager(
      dataSource,
      unusedDependency<IShowcaseRepository>(),
      unusedDependency<IProjectRepository>(),
      unusedDependency<IWorkspaceBoundary>(),
      unusedDependency<TypeOrmProjectFileAccess>(),
      unusedDependency<ProjectFileGateway>(),
      unusedDependency<StorageQuotaFileMutation>(),
      unusedDependency<TypeOrmStorageQuotaRepository>(),
      unusedDependency<TypeOrmStorageContentAccounting>(),
      undefined
    );

    await expect(manager.getStatus(OWNER_ID)).resolves.toEqual({
      state: 'pending', projectId: null, retryAllowed: false, workspaceMode: null, capabilities: null
    });
    await expect(manager.getStatus(OWNER_ID)).resolves.toEqual({
      state: 'ready', projectId: PROJECT_ID, retryAllowed: false,
      workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false }
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('WHERE "owner_id" = $1'), [OWNER_ID]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE "owner_id" = $1'), [OWNER_ID]);
  });
});

function managerFor(query: jest.Mock, configured = true): TypeOrmDemoShowcaseCopyManager {
  return new TypeOrmDemoShowcaseCopyManager(
    { query } as unknown as DataSource, unusedDependency<IShowcaseRepository>(), unusedDependency<IProjectRepository>(),
    unusedDependency<IWorkspaceBoundary>(), unusedDependency<TypeOrmProjectFileAccess>(), unusedDependency<ProjectFileGateway>(),
    unusedDependency<StorageQuotaFileMutation>(), unusedDependency<TypeOrmStorageQuotaRepository>(),
    unusedDependency<TypeOrmStorageContentAccounting>(), configured ? { maxSnapshotBytes: 1000000, maxFileBytes: 10000, maxItems: 100,
      maxFiles: 10, maxRetainedVersions: 10, maxCopyAttempts: 3 } : undefined
  );
}

describe('demo bundle readiness', () => {
  const ready = { target_project_id: PROJECT_ID, state: 'ready', retry_allowed: false, workspace_mode: 'file_backed', file_access: true };

  it('does not expose a partially copied bundle, including when the primary is already ready', async () => {
    const query = jest.fn().mockResolvedValue([ready, { ...ready, state: 'pending', workspace_mode: null, file_access: null }]);
    await expect(managerFor(query).getStatus(OWNER_ID)).resolves.toMatchObject({ state: 'pending', projectId: null, retryAllowed: true });
  });

  it('reports a non-retryable failed member without exposing a ready primary', async () => {
    const query = jest.fn().mockResolvedValue([ready, { ...ready, state: 'failed', retry_allowed: false }]);
    await expect(managerFor(query).getStatus(OWNER_ID)).resolves.toMatchObject({ state: 'failed', projectId: null, retryAllowed: false });
  });

  it('returns the primary only after every member is ready', async () => {
    const query = jest.fn().mockResolvedValue([ready, { ...ready, target_project_id: 'other' }, ready]);
    await expect(managerFor(query).getStatus(OWNER_ID)).resolves.toMatchObject({ state: 'ready', projectId: PROJECT_ID });
  });

  it('provisions each copy with its distinct identity and the same owner', async () => {
    const query = jest.fn().mockResolvedValue([{ copy_id: 'primary' }, { copy_id: 'community' }, { copy_id: 'writing' }]);
    const manager = managerFor(query);
    // Exercise batch orchestration without touching any copy filesystem adapter.
    const run = jest.spyOn(manager as unknown as { run(copyId: string, ownerId: string): Promise<void> }, 'run').mockResolvedValue();
    await manager.provision('admission', OWNER_ID);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('"admission_id" = $1 AND "owner_id" = $2'), ['admission', OWNER_ID]);
    expect(run.mock.calls).toEqual([['primary', OWNER_ID], ['community', OWNER_ID], ['writing', OWNER_ID]]);
  });
});
