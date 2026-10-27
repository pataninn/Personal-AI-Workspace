import { AppError } from '@/shared/errors/app-error';
import type { WorkspaceExportBuilderIdentity } from '@/modules/workspace-exports/domain/workspace-export';
import type {
  IWorkspaceExportArtifactStore,
  IWorkspaceExportRepository,
  WorkspaceExportRecord
} from '@/modules/workspace-exports/repositories/workspace-export-repository';
import { ReconcileWorkspaceExports } from '@/modules/workspace-exports/use-cases/reconcile-workspace-exports';

const BUILDER: WorkspaceExportBuilderIdentity = { processId: 91, startTicks: '987654321' };
const ID = '11111111-1111-4111-8111-111111111111';

function record(state: WorkspaceExportRecord['state'] = 'building'): WorkspaceExportRecord {
  return {
    id: ID, ownerId: '22222222-2222-4222-8222-222222222222', workspaceId: '33333333-3333-4333-8333-333333333333',
    state, requestFingerprint: 'a'.repeat(64), demoCleanupGeneration: null, builder: state === 'building' ? BUILDER : null,
    createdAt: new Date('2026-10-20T00:00:00.000Z'), expiresAt: null, sizeBytes: null
  };
}

function fixture(liveness: 'active' | 'absent' | 'reused' | 'unknown', state: 'building' | 'ready' = 'building') {
  const calls: string[] = [];
  const current = record(state);
  const repository = {
    listByIds: jest.fn(async () => current.state === 'building' ? [current] : []),
    markFailedIfBuilderMatches: jest.fn(async () => {
      calls.push('terminalize');
      Object.assign(current, { state: 'failed', builder: null });
      return true;
    }),
    deleteTerminal: jest.fn(async () => { calls.push('delete-rows'); }),
    listForStartup: jest.fn(async () => [current]),
    markUnavailable: jest.fn(), markExpired: jest.fn(async () => false), deleteOldTombstones: jest.fn()
  } as unknown as jest.Mocked<IWorkspaceExportRepository>;
  const artifacts = {
    remove: jest.fn(async () => { calls.push('unlink'); }),
    listPartIds: jest.fn(async () => []), exists: jest.fn(async () => true), read: jest.fn(), write: jest.fn()
  } as unknown as jest.Mocked<IWorkspaceExportArtifactStore>;
  const reconciler = new ReconcileWorkspaceExports(repository, artifacts, async () => liveness, () => true);
  return { calls, current, repository, artifacts, reconciler };
}

describe('workspace export cleanup fences', () => {
  it.each(['active', 'unknown'] as const)('does not unlink or delete while a builder is %s', async (liveness) => {
    const { calls, repository, artifacts, reconciler } = fixture(liveness);
    await expect(reconciler.waitForTerminalAndRemove([ID], 0)).rejects.toMatchObject({ code: 'EXPORT_CLEANUP_PENDING' });
    expect(artifacts.remove).not.toHaveBeenCalled();
    expect(repository.deleteTerminal).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each(['absent', 'reused'] as const)('terminalizes a confirmed-gone writer before unlinking (%s)', async (liveness) => {
    const { calls, repository, artifacts, reconciler } = fixture(liveness);
    await reconciler.waitForTerminalAndRemove([ID]);
    expect(calls).toEqual(['terminalize', 'unlink', 'delete-rows']);
    expect(repository.markFailedIfBuilderMatches).toHaveBeenCalledWith(ID, BUILDER);
  });

  it('keeps partial artifacts associated with any still-building row during startup', async () => {
    const { artifacts, reconciler } = fixture('unknown');
    (artifacts.listPartIds as jest.Mock).mockResolvedValue([ID]);
    await reconciler.reconcileStartup();
    expect(artifacts.remove).not.toHaveBeenCalled();
  });

  it('does not unlink a ready artifact when only the application clock says it has expired', async () => {
    const { current, repository, artifacts, reconciler } = fixture('unknown', 'ready');
    Object.assign(current, { expiresAt: new Date('2020-01-01T00:00:00.000Z') });
    await reconciler.reconcileStartup();
    expect(repository.markExpired).toHaveBeenCalledWith(ID);
    expect(artifacts.exists).toHaveBeenCalledWith(ID);
    expect(artifacts.remove).not.toHaveBeenCalled();
  });
});

describe('cleanup timeout error', () => {
  it('uses a retryable service response without claiming the writer is terminal', async () => {
    const { repository, reconciler } = fixture('active');
    let caught: unknown;
    try { await reconciler.waitForTerminalAndRemove([ID], 0); } catch (error: unknown) { caught = error; }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code: 'EXPORT_CLEANUP_PENDING', statusCode: 503 });
    expect(repository.markFailedIfBuilderMatches).not.toHaveBeenCalled();
  });
});
