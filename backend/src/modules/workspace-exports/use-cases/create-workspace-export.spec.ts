import { AppError } from '@/shared/errors/app-error';
import type { WorkspaceExportBuilderIdentity, WorkspaceExportSnapshot } from '@/modules/workspace-exports/domain/workspace-export';
import type { IProjectFileAccess, IProjectFileGateway } from '@/modules/files/repositories/project-file-access';
import type { WorkspaceProjectScope } from '@/modules/files/domain/workspace-types';
import type { IWorkspaceExportArtifactStore, IWorkspaceExportRepository, WorkspaceExportRecord } from '@/modules/workspace-exports/repositories/workspace-export-repository';
import { CreateWorkspaceExportUseCase } from '@/modules/workspace-exports/use-cases/create-workspace-export';

const OWNER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const EXPORT = '33333333-3333-4333-8333-333333333333';
const BUILDER: WorkspaceExportBuilderIdentity = { processId: 91, startTicks: '987654321' };
const SNAPSHOT: WorkspaceExportSnapshot = {
  workspace: { id: WORKSPACE, name: 'Research', objective: null }, fileBacked: true,
  databaseSnapshotAt: '2026-10-20T10:00:00.000Z', tasks: [], facts: [],
  context: { relativePaths: [], factIds: [], includeProjectConversations: true, excludedPaths: [] },
  projectConversations: [], homeConversations: [], skills: [], schedules: []
};
const FILE = { path: 'docs/readme.bin', encoding: 'base64' as const, sizeBytes: 3, sha256: 'a'.repeat(64), content: 'AP8B' };

function fixture(overrides: { readonly snapshot?: WorkspaceExportSnapshot; readonly builderFailure?: boolean } = {}) {
  const record: WorkspaceExportRecord = {
    id: EXPORT, ownerId: OWNER, workspaceId: WORKSPACE, state: 'building', requestFingerprint: 'a'.repeat(64),
    demoCleanupGeneration: null, builder: BUILDER, createdAt: new Date('2026-10-20T10:00:00.000Z'), expiresAt: null, sizeBytes: null
  };
  const descriptor = { id: EXPORT, workspaceId: WORKSPACE, sizeBytes: 1, expiresAt: '2026-10-20T10:15:00.000Z' };
  const repository = {
    begin: jest.fn(async () => ({ kind: 'started' as const, record })),
    captureSnapshot: jest.fn(async () => overrides.snapshot ?? SNAPSHOT),
    publish: jest.fn(async (_id, _owner, _workspace, _generation, sizeBytes) => ({ ...descriptor, sizeBytes })),
    markFailed: jest.fn(async () => undefined)
  } as unknown as jest.Mocked<IWorkspaceExportRepository>;
  const artifacts = {
    write: jest.fn(async () => undefined), remove: jest.fn(async () => undefined)
  } as unknown as jest.Mocked<IWorkspaceExportArtifactStore>;
  const fileScope: WorkspaceProjectScope = { ownerId: OWNER, projectId: WORKSPACE, storageKind: 'legacy', relativeRoot: 'research' };
  const files = { execute: jest.fn(async (_input, action) => action(fileScope)) } as unknown as IProjectFileAccess;
  const gateway = { captureForExport: jest.fn(async () => [FILE]) } as unknown as IProjectFileGateway;
  const getBuilderIdentity = jest.fn(async () => {
    if (overrides.builderFailure) throw new Error('proc unavailable');
    return BUILDER;
  });
  return { useCase: new CreateWorkspaceExportUseCase(repository, artifacts, files, gateway, getBuilderIdentity), repository, artifacts, files, gateway, getBuilderIdentity, descriptor };
}

describe('CreateWorkspaceExportUseCase', () => {
  it('serializes the explicit snapshot and base64 file projection before publication', async () => {
    const test = fixture();
    const result = await test.useCase.execute({ ownerId: OWNER, workspaceId: WORKSPACE, idempotencyKey: 'export-123' });
    expect(result).toEqual({ descriptor: expect.objectContaining({ id: EXPORT, workspaceId: WORKSPACE }), replayed: false });
    const bytes = (test.artifacts.write as jest.Mock).mock.calls[0]?.[1] as Buffer;
    const document = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(document).sort()).toEqual(['conversations', 'files', 'manifest', 'memory', 'schedules', 'skills', 'tasks', 'workspace']);
    expect(document.files).toEqual([FILE]);
    expect((document.manifest as Record<string, unknown>).databaseSnapshotAt).toBe(SNAPSHOT.databaseSnapshotAt);
    expect(test.repository.publish).toHaveBeenCalledWith(EXPORT, OWNER, WORKSPACE, null, bytes.byteLength, expect.any(Number));
  });

  it('removes the temporary artifact and leaves a failed tombstone when structured data exceeds its bound', async () => {
    const test = fixture({ snapshot: { ...SNAPSHOT, facts: [{
      id: 'fact', key: 'k', title: 'large', content: 'x'.repeat(8 * 1024 * 1024 + 1), version: 1,
      verificationStatus: 'needs_review', verifiedAt: null, createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z'
    }] } });
    await expect(test.useCase.execute({ ownerId: OWNER, workspaceId: WORKSPACE, idempotencyKey: 'export-124' }))
      .rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE', statusCode: 413 });
    expect(test.artifacts.write).not.toHaveBeenCalled();
    expect(test.artifacts.remove).toHaveBeenCalledWith(EXPORT);
    expect(test.repository.markFailed).toHaveBeenCalledWith(EXPORT);
  });

  it('rejects a recognized credential in structured conversation text without reading files or creating an artifact', async () => {
    const test = fixture({ snapshot: { ...SNAPSHOT, projectConversations: [{
      id: 'conversation', title: 'Review', createdAt: SNAPSHOT.databaseSnapshotAt, updatedAt: SNAPSHOT.databaseSnapshotAt,
      messages: [{ id: 'message', turnId: null, sequence: 1, role: 'user', content: 'NVIDIA_API_KEY=fixture-only-value', createdAt: SNAPSHOT.databaseSnapshotAt }]
    }] } });
    await expect(test.useCase.execute({ ownerId: OWNER, workspaceId: WORKSPACE, idempotencyKey: 'export-127' }))
      .rejects.toMatchObject({ code: 'EXPORT_CONTENT_UNSAFE', statusCode: 422 });
    expect(test.files.execute).not.toHaveBeenCalled();
    expect(test.artifacts.write).not.toHaveBeenCalled();
    expect(test.artifacts.remove).toHaveBeenCalledWith(EXPORT);
    expect(test.repository.markFailed).toHaveBeenCalledWith(EXPORT);
  });

  it('fails closed before creating lifecycle metadata if process identity is unavailable', async () => {
    const test = fixture({ builderFailure: true });
    await expect(test.useCase.execute({ ownerId: OWNER, workspaceId: WORKSPACE, idempotencyKey: 'export-125' }))
      .rejects.toMatchObject({ code: 'EXPORT_FAILED', statusCode: 500 });
    expect(test.repository.begin).not.toHaveBeenCalled();
  });

  it('keeps the timed-out builder building until its work reaches a terminal state', async () => {
    jest.useFakeTimers();
    const test = fixture();
    (test.repository.captureSnapshot as jest.Mock).mockImplementation(() => new Promise(() => undefined));
    const pending = test.useCase.execute({ ownerId: OWNER, workspaceId: WORKSPACE, idempotencyKey: 'export-126' })
      .then(() => null, (error: unknown) => error);
    await jest.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toMatchObject({ code: 'EXPORT_TOO_LARGE', statusCode: 413 });
    expect(test.repository.markFailed).not.toHaveBeenCalled();
    expect(test.artifacts.remove).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
