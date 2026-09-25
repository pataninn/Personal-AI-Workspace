import { createHash } from 'node:crypto';

import type { AiRun } from '@/modules/ai-runs/domain/ai-run-types';
import type { ChangeSetResult, ProposedChangeOperation, ProposedChangeSet, RuntimeChangeProposal } from '@/modules/ai-runs/domain/change-types';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IProposedChangeSetRepository } from '@/modules/ai-runs/repositories/change-set-repository';
import type { IWorkspaceMutationGateway, WorkspaceApplyResult, WorkspaceFileSnapshot, WorkspaceMutationApplyOptions, WorkspaceMutationScope } from '@/modules/ai-runs/repositories/workspace-mutation-gateway';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { Project } from '@/modules/projects/domain/project-types';
import { InMemoryProposedChangeSetRepository } from '@/infrastructure/ai-runs/in-memory-change-set-repository';
import { CollectProposedChangeSetUseCase, DecideProposedChangeSetUseCase } from '@/modules/ai-runs/use-cases/change-set-use-cases';
import { ChangeSetConflictError } from '@/modules/ai-runs/domain/change-errors';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const FILE_PATH = 'src/app.ts';
const ORIGINAL = 'const token = "secret-value";\n';
const ORIGINAL_HASH = hash(ORIGINAL);

describe('proposed change-set use cases', () => {
  it('collects immutable bounded operations with a redacted preview and exact source hash', async () => {
    const workspace = new WorkspaceFixture();
    const repository = new InMemoryProposedChangeSetRepository();
    const useCase = new CollectProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), workspace, repository);
    const changes: readonly RuntimeChangeProposal[] = [{ operation: 'edit', path: FILE_PATH, content: 'const replacement = "updated";\n', summary: 'replace implementation' }];

    const result = await useCase.execute({ ownerId: OWNER_ID, runId: RUN_ID, changes, fakeRuntime: true });

    expect(result.status).toBe('awaiting_approval');
    expect(result.fakeRuntime).toBe(true);
    expect(result.operations[0]).toMatchObject({ path: FILE_PATH, expectedSourceHash: ORIGINAL_HASH, backupRequired: false });
    expect(result.operations[0]?.preview?.text).not.toContain('secret-value');
    expect(result.proposalHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await repository.findByRunForOwner(OWNER_ID, RUN_ID)).toEqual(result);
  });

  it('persists the decision before applying and persists the authoritative applied result', async () => {
    const workspace = new WorkspaceFixture();
    const repository = new InMemoryProposedChangeSetRepository();
    const collect = new CollectProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), workspace, repository);
    const decision = new DecideProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), repository, workspace);
    const changeSet = await collect.execute({ ownerId: OWNER_ID, runId: RUN_ID, changes: [{ operation: 'edit', path: FILE_PATH, content: 'updated\n' }], fakeRuntime: true });

    const result = await decision.execute({ ownerId: OWNER_ID, runId: RUN_ID, proposalHash: changeSet.proposalHash, decision: 'approve', idempotencyKey: 'decision-1' });

    expect(workspace.applied).toBe(true);
    expect(result.status).toBe('applied');
    expect(result.decision).toBe('approved');
    expect(result.result).toMatchObject({ persisted: true, appliedCount: 1, backupCount: 1 });
    expect((await repository.findByRunForOwner(OWNER_ID, RUN_ID))?.result).toEqual(result.result);
  });

  it('records stale apply outcomes before returning a conflict to the caller', async () => {
    const workspace = new WorkspaceFixture();
    workspace.applyOutcome = { outcome: 'stale', conflict: { path: FILE_PATH, reason: 'changed' }, operations: [{ operationId: 'stale', operation: 'edit', path: FILE_PATH, status: 'skipped', backup: 'not_required', safeMessage: 'stale' }] };
    const repository = new InMemoryProposedChangeSetRepository();
    const collect = new CollectProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), workspace, repository);
    const decision = new DecideProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), repository, workspace);
    const changeSet = await collect.execute({ ownerId: OWNER_ID, runId: RUN_ID, changes: [{ operation: 'edit', path: FILE_PATH, content: 'updated\n' }], fakeRuntime: true });

    await expect(decision.execute({ ownerId: OWNER_ID, runId: RUN_ID, proposalHash: changeSet.proposalHash, decision: 'approve', idempotencyKey: 'decision-2' })).rejects.toBeInstanceOf(ChangeSetConflictError);
    expect((await repository.findByRunForOwner(OWNER_ID, RUN_ID))?.status).toBe('stale');
  });

  it('persists a private recovery checkpoint before the workspace reports success and safely replays a lost response', async () => {
    const workspace = new WorkspaceFixture();
    const repository = new InMemoryProposedChangeSetRepository();
    const collect = new CollectProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), workspace, repository);
    const decision = new DecideProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), repository, workspace);
    const changeSet = await collect.execute({ ownerId: OWNER_ID, runId: RUN_ID, changes: [{ operation: 'edit', path: FILE_PATH, content: 'updated\n' }], fakeRuntime: true });

    const result = await decision.execute({ ownerId: OWNER_ID, runId: RUN_ID, proposalHash: changeSet.proposalHash, decision: 'approve', idempotencyKey: 'decision-checkpoint' });
    const persisted = await repository.findByRunForOwner(OWNER_ID, RUN_ID);
    expect(workspace.checkpointedBeforeMutation).toBe(true);
    expect(persisted?.backupCheckpoints).toHaveLength(1);
    expect(persisted?.backupCheckpoints?.[0]).toMatchObject({ operationId: changeSet.operations[0]?.operationId, path: FILE_PATH });
    expect(JSON.stringify(persisted?.backupCheckpoints)).not.toContain('updated');

    const replay = await decision.execute({ ownerId: OWNER_ID, runId: RUN_ID, proposalHash: changeSet.proposalHash, decision: 'approve', idempotencyKey: 'decision-checkpoint' });
    expect(replay).toEqual(result);
    expect(workspace.applyCalls).toBe(1);
  });

  it('fails closed to manual review when checkpoint persistence fails before destructive I/O', async () => {
    const workspace = new WorkspaceFixture();
    const repository = new InMemoryProposedChangeSetRepository();
    const originalSave = repository.save.bind(repository);
    repository.save = jest.fn(async (changeSet) => {
      if (changeSet.backupCheckpoints && changeSet.backupCheckpoints.length > 0) throw new Error('checkpoint store unavailable');
      await originalSave(changeSet);
    });
    const collect = new CollectProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), workspace, repository);
    const decision = new DecideProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), repository, workspace);
    const changeSet = await collect.execute({ ownerId: OWNER_ID, runId: RUN_ID, changes: [{ operation: 'edit', path: FILE_PATH, content: 'updated\n' }], fakeRuntime: true });

    await expect(decision.execute({ ownerId: OWNER_ID, runId: RUN_ID, proposalHash: changeSet.proposalHash, decision: 'approve', idempotencyKey: 'decision-checkpoint-fails' })).rejects.toMatchObject({ code: 'CHANGE_SET_REVIEW_REQUIRED' });
    expect(workspace.applied).toBe(false);
    expect((await repository.findByRunForOwner(OWNER_ID, RUN_ID))?.status).toBe('needs_manual_review');
  });

  it('drops raw proposed bytes after a terminal decision while retaining the safe preview/result', async () => {
    const workspace = new WorkspaceFixture();
    const repository = new InMemoryProposedChangeSetRepository();
    const collect = new CollectProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), workspace, repository);
    const decision = new DecideProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), repository, workspace);
    const changeSet = await collect.execute({ ownerId: OWNER_ID, runId: RUN_ID, changes: [{ operation: 'edit', path: FILE_PATH, content: 'const value = "terminal-secret";', summary: 'replace value' }], fakeRuntime: true });
    expect(changeSet.operations[0]).toHaveProperty('content', 'const value = "terminal-secret";');

    const rejected = await decision.execute({ ownerId: OWNER_ID, runId: RUN_ID, proposalHash: changeSet.proposalHash, decision: 'reject', idempotencyKey: 'decision-retention' });

    expect(rejected.status).toBe('rejected');
    expect(rejected.operations[0]).not.toHaveProperty('content');
    expect(JSON.stringify(rejected)).not.toContain('terminal-secret');
  });

  it('rejects secret-bearing model change content before proposal persistence', async () => {
    const workspace = new WorkspaceFixture();
    const repository = new InMemoryProposedChangeSetRepository();
    const useCase = new CollectProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), workspace, repository);

    await expect(useCase.execute({
      ownerId: OWNER_ID,
      runId: RUN_ID,
      changes: [{ operation: 'edit', path: FILE_PATH, content: 'NVIDIA_API_KEY=secret-value' }],
      fakeRuntime: false
    })).rejects.toMatchObject({ code: 'CHANGE_SET_INVALID' });
    await expect(repository.findByRunForOwner(OWNER_ID, RUN_ID)).resolves.toBeNull();
  });
});

class RunRepository implements IAiRunRepository {
  public run: AiRun = {
    id: RUN_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    conversationId: '44444444-4444-4444-8444-444444444444',
    request: 'edit the file',
    relativeRoot: 'project',
    requestedPaths: [FILE_PATH],
    manifest: { manifestHash: 'b'.repeat(64), provider: 'NVIDIA hosted NIM', providerProfile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b', categories: ['Request'], files: [{ relativePath: FILE_PATH, sourceHash: ORIGINAL_HASH, sizeBytes: ORIGINAL.length }], requestBytes: 14, messageBytes: 0, messageCount: 0, messageHash: 'c'.repeat(64), byteEstimate: 14, tokenEstimate: 4, excludedItemCount: 0, omittedItemCount: 0, omissionSummary: 'No selected items were excluded or omitted.', bestEffortSecretDetection: true },
    manifestInvalidated: false,
    status: 'succeeded',
    phase: 'terminal',
    decision: 'approved',
    cleanup: 'complete',
    providerTransmission: 'not_started_confirmed',
    stagingItemCount: 0,
    runtimeKind: 'fake',
    sandboxReady: true,
    safeMessage: 'Complete',
    createdAt: new Date('2026-09-16T00:00:00.000Z'),
    updatedAt: new Date('2026-09-16T00:00:00.000Z')
  };
  public async create(): Promise<never> { throw new Error('unused'); }
  public async findByIdForOwner(ownerId: string, runId: string): Promise<AiRun | null> { return ownerId === OWNER_ID && runId === RUN_ID ? this.run : null; }
  public async recordDecision(): Promise<never> { throw new Error('unused'); }
  public async save(run: AiRun): Promise<void> { this.run = run; }
}

class ProjectRepository implements IProjectRepository {
  public project: Project = { id: PROJECT_ID, ownerId: OWNER_ID, name: 'Project', slug: 'project', relativeRoot: 'project', status: 'active', version: 1, createdAt: new Date(), updatedAt: new Date() };
  public async listByOwner(): Promise<readonly Project[]> { return [this.project]; }
  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> { return ownerId === OWNER_ID && projectId === PROJECT_ID ? this.project : null; }
  public async listActiveRoots(): Promise<readonly string[]> { return [this.project.relativeRoot]; }
  public async create(): Promise<Project> { return this.project; }
  public async updateStatus(): Promise<Project | null> { return this.project; }
}

class WorkspaceFixture implements IWorkspaceMutationGateway {
  public applied = false;
  public applyCalls = 0;
  public checkpointedBeforeMutation = false;
  public applyOutcome: WorkspaceApplyResult = { outcome: 'applied', operations: [{ operationId: 'edit-src', operation: 'edit', path: FILE_PATH, status: 'applied', backup: 'created', safeMessage: 'Edited.' }] };
  public async inspect(_scope: WorkspaceMutationScope, relativePath: string): Promise<WorkspaceFileSnapshot> {
    return relativePath === FILE_PATH ? { path: relativePath, exists: true, isDirectory: false, sizeBytes: Buffer.byteLength(ORIGINAL), content: ORIGINAL, hash: ORIGINAL_HASH } : { path: relativePath, exists: false, isDirectory: false, sizeBytes: 0 };
  }
  public async applyChangeSet(_scope: WorkspaceMutationScope, operations: readonly ProposedChangeOperation[], _runId: string, _proposalHash: string, options?: WorkspaceMutationApplyOptions): Promise<WorkspaceApplyResult> {
    this.applyCalls += 1;
    await options?.recordBackupCheckpoint?.({ reference: 'private/checkpoint', operationId: operations[0]?.operationId ?? 'operation', path: FILE_PATH, sizeBytes: ORIGINAL.length, contentSha256: ORIGINAL_HASH, createdAt: new Date() });
    this.checkpointedBeforeMutation = true;
    this.applied = true;
    return this.applyOutcome;
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
