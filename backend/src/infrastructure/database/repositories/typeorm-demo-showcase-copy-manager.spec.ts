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
