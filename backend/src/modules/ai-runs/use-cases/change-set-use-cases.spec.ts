import { createHash } from 'node:crypto';

import type { AiRun } from '@/modules/ai-runs/domain/ai-run-types';
import type { ChangeSetResult, ProposedChangeOperation, ProposedChangeSet, RuntimeChangeProposal } from '@/modules/ai-runs/domain/change-types';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IProposedChangeSetRepository } from '@/modules/ai-runs/repositories/change-set-repository';
import type { IWorkspaceMutationGateway, WorkspaceApplyResult, WorkspaceFileSnapshot, WorkspaceMutationApplyOptions, WorkspaceMutationScope } from '@/modules/ai-runs/repositories/workspace-mutation-gateway';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { Project } from '@/modules/projects/domain/project-types';
import { InMemoryProposedChangeSetRepository } from '@/infrastructure/ai-runs/in-memory-change-set-repository';
import { CollectProposedChangeSetUseCase, DecideProposedChangeSetUseCase, GetProposedChangeSetUseCase } from '@/modules/ai-runs/use-cases/change-set-use-cases';
import { ChangeSetConflictError } from '@/modules/ai-runs/domain/change-errors';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const FILE_PATH = 'src/app.ts';
const ORIGINAL = 'const token = "secret-value";\n';
const ORIGINAL_HASH = hash(ORIGINAL);

describe('proposed change-set use cases', () => {
  it('automatically applies changes to an authorized running run exactly once', async () => {
    const runs = new RunRepository();
    runs.run = { ...runs.run, status: 'running' };
    const workspace = new WorkspaceFixture();
    const repository = new InMemoryProposedChangeSetRepository();
    const collect = new CollectProposedChangeSetUseCase(runs, new ProjectRepository(), workspace, repository);
    await collect.execute({ ownerId: OWNER_ID, runId: RUN_ID, changes: [{ operation: 'edit', path: FILE_PATH, content: 'updated\n' }], fakeRuntime: false });
    const decision = new DecideProposedChangeSetUseCase(runs, new ProjectRepository(), repository, workspace);
    expect((await decision.executeAutomatically({ ownerId: OWNER_ID, runId: RUN_ID }))?.status).toBe('applied');
    expect((await decision.executeAutomatically({ ownerId: OWNER_ID, runId: RUN_ID }))?.status).toBe('applied');
    expect(workspace.applyCalls).toBe(1);
  });

  it('does not automatically apply files for a cancelled run', async () => {
    const runs = new RunRepository();
    const workspace = new WorkspaceFixture();
    const repository = new InMemoryProposedChangeSetRepository();
    await new CollectProposedChangeSetUseCase(runs, new ProjectRepository(), workspace, repository).execute({ ownerId: OWNER_ID, runId: RUN_ID, changes: [{ operation: 'delete', path: FILE_PATH }], fakeRuntime: false });
    runs.run = { ...runs.run, status: 'cancelled' };
    await expect(new DecideProposedChangeSetUseCase(runs, new ProjectRepository(), repository, workspace).executeAutomatically({ ownerId: OWNER_ID, runId: RUN_ID })).rejects.toMatchObject({ code: 'CHANGE_SET_BLOCKED' });
    expect(workspace.applyCalls).toBe(0);
  });

  it('accepts ordinary file names without restricting their extensions', async () => {
    const collect = new CollectProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), new WorkspaceFixture(), new InMemoryProposedChangeSetRepository());
    const result = await collect.execute({ ownerId: OWNER_ID, runId: RUN_ID, changes: [{ operation: 'create', path: 'App.svelte', content: '<h1>Hello</h1>' }, { operation: 'create', path: '.gitignore', content: 'dist/\n' }], fakeRuntime: false });
    expect(result.operations.map((operation) => operation.path)).toEqual(['App.svelte', '.gitignore']);
  });

  it.each(['rename', 'delete'] as const)('updates project context after an automatically applied $0 without overwriting facts', async (operation) => {
    const runs = new RunRepository();
    runs.run = { ...runs.run, status: 'running' };
    const workspace = new WorkspaceFixture();
    workspace.applyOutcome = { outcome: 'applied', operations: [{ operationId: 'test-operation', operation, path: FILE_PATH, ...(operation === 'rename' ? { destinationPath: 'src/new.svelte' } : {}), status: 'applied', backup: 'created', safeMessage: 'Applied.' }] };
    const repository = new InMemoryProposedChangeSetRepository();
    await new CollectProposedChangeSetUseCase(runs, new ProjectRepository(), workspace, repository).execute({ ownerId: OWNER_ID, runId: RUN_ID, changes: [{ operation, path: FILE_PATH, ...(operation === 'rename' ? { destinationPath: 'src/new.svelte' } : {}) }], fakeRuntime: false });
    const contexts = { get: jest.fn().mockResolvedValue({ relativePaths: [FILE_PATH, 'notes.md'], factIds: ['selected-fact'], includeProjectConversations: true }), update: jest.fn() };
    await new DecideProposedChangeSetUseCase(runs, new ProjectRepository(), repository, workspace, contexts).executeAutomatically({ ownerId: OWNER_ID, runId: RUN_ID });
    expect(contexts.update).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID, { relativePaths: operation === 'rename' ? ['src/new.svelte', 'notes.md'] : ['notes.md'] });
  });

  it('collects immutable bounded operations with a redacted preview and exact source hash', async () => {
    const workspace = new WorkspaceFixture();
    const repository = new InMemoryProposedChangeSetRepository();
    const useCase = new CollectProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), workspace, repository);
    const changes: readonly RuntimeChangeProposal[] = [{ operation: 'edit', path: FILE_PATH, content: 'const replacement = "updated";\n', summary: 'replace implementation' }];

    const result = await useCase.execute({ ownerId: OWNER_ID, runId: RUN_ID, changes, fakeRuntime: true });

    expect(result.status).toBe('awaiting_approval');
    expect(result.fakeRuntime).toBe(true);
    expect(result.operations[0]).toMatchObject({ path: FILE_PATH, expectedSourceHash: ORIGINAL_HASH, backupRequired: true });
    expect(result.operations[0]?.preview?.text).not.toContain('secret-value');
    expect(result.proposalHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await repository.findByRunForOwner(OWNER_ID, RUN_ID)).toEqual(result);
  });

  it('does not read proposed change-set history for a planning project', async () => {
    const runs = new RunRepository();
    const projects = new ProjectRepository();
    projects.project = { ...projects.project, relativeRoot: null };
    const changeSets = new InMemoryProposedChangeSetRepository();
    const findChangeSet = jest.spyOn(changeSets, 'findByRunForOwner');
    const get = new GetProposedChangeSetUseCase(runs, projects, changeSets);

    await expect(get.execute({ ownerId: OWNER_ID, runId: RUN_ID })).rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED', statusCode: 409 });
    expect(findChangeSet).not.toHaveBeenCalled();
  });

  it('builds a line diff with unchanged context, additions, and removals', async () => {
    const workspace = new WorkspaceFixture();
    workspace.snapshotContent = 'first\nkeep\nold\n';
    const runs = new RunRepository();
    runs.run = { ...runs.run, manifest: { ...runs.run.manifest, files: [{ relativePath: FILE_PATH, sourceHash: hash(workspace.snapshotContent), sizeBytes: Buffer.byteLength(workspace.snapshotContent) }] } };
    const useCase = new CollectProposedChangeSetUseCase(runs, new ProjectRepository(), workspace, new InMemoryProposedChangeSetRepository());
    const result = await useCase.execute({ ownerId: OWNER_ID, runId: RUN_ID, changes: [{ operation: 'edit', path: FILE_PATH, content: 'first\nkeep\nnew\n' }], fakeRuntime: true });
    expect(result.operations[0]?.preview).toMatchObject({ kind: 'diff', limited: false });
    expect(result.operations[0]?.preview?.text).toBe('  first\n  keep\n- old\n+ new\n  ');
  });

  it('rejects files changed since the model received their context', async () => {
    const workspace = new WorkspaceFixture();
    workspace.snapshotContent = 'Edited locally while AI was working\n';
    await expect(new CollectProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), workspace, new InMemoryProposedChangeSetRepository()).execute({ ownerId: OWNER_ID, runId: RUN_ID, changes: [{ operation: 'edit', path: FILE_PATH, content: 'AI edit\n' }], fakeRuntime: false })).rejects.toMatchObject({ code: 'CHANGE_SET_CONFLICT' });
    expect(workspace.applyCalls).toBe(0);
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
    expect((await repository.findByRunForOwner(OWNER_ID, RUN_ID))?.result).toMatchObject({ appliedCount: 0, skippedCount: 1, conflictPath: FILE_PATH });
  });

  it('preserves known earlier writes when a later operation becomes stale', async () => {
    const workspace = new WorkspaceFixture();
    workspace.applyOutcome = {
      outcome: 'stale', conflict: { path: 'src/second.ts', reason: 'changed' }, operations: [
        { operationId: 'first-result', operation: 'edit', path: FILE_PATH, status: 'applied', backup: 'created', safeMessage: 'done' },
      { operationId: 'second-result', operation: 'create', path: 'src/second.ts', status: 'skipped', backup: 'not_required', safeMessage: 'stale' }
      ]
    };
    const repository = new InMemoryProposedChangeSetRepository();
    const collect = new CollectProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), workspace, repository);
    const decision = new DecideProposedChangeSetUseCase(new RunRepository(), new ProjectRepository(), repository, workspace);
    const changeSet = await collect.execute({ ownerId: OWNER_ID, runId: RUN_ID, changes: [{ operation: 'edit', path: FILE_PATH, content: 'first' }, { operation: 'create', path: 'src/second.ts', content: 'second' }], fakeRuntime: true });
    await expect(decision.execute({ ownerId: OWNER_ID, runId: RUN_ID, proposalHash: changeSet.proposalHash, decision: 'approve', idempotencyKey: 'partial-stale' })).rejects.toBeInstanceOf(ChangeSetConflictError);
    const saved = await repository.findByRunForOwner(OWNER_ID, RUN_ID);
    expect(saved?.result).toMatchObject({ appliedCount: 1, skippedCount: 1, backupCount: 1, conflictPath: 'src/second.ts' });
    expect(saved?.safeMessage).toContain('Some earlier operations were applied');
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
  public project: Project = { id: PROJECT_ID, ownerId: OWNER_ID, name: 'Project', slug: 'project', relativeRoot: 'project', objective: null, status: 'active', version: 1, createdAt: new Date(), updatedAt: new Date() };
  public async listByOwner(): Promise<readonly Project[]> { return [this.project]; }
  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> { return ownerId === OWNER_ID && projectId === PROJECT_ID ? this.project : null; }
  public async listActiveRoots(): Promise<readonly string[]> { return this.project.relativeRoot === null ? [] : [this.project.relativeRoot]; }
  public async create(): Promise<Project> { return this.project; }
  public async updateStatus(): Promise<Project | null> { return this.project; }
}

class WorkspaceFixture implements IWorkspaceMutationGateway {
  public applied = false;
  public applyCalls = 0;
  public checkpointedBeforeMutation = false;
  public snapshotContent = ORIGINAL;
  public applyOutcome: WorkspaceApplyResult = { outcome: 'applied', operations: [{ operationId: 'edit-src', operation: 'edit', path: FILE_PATH, status: 'applied', backup: 'created', safeMessage: 'Edited.' }] };
  public async inspect(_scope: WorkspaceMutationScope, relativePath: string): Promise<WorkspaceFileSnapshot> {
    return relativePath === FILE_PATH ? { path: relativePath, exists: true, isDirectory: false, sizeBytes: Buffer.byteLength(this.snapshotContent), content: this.snapshotContent, hash: hash(this.snapshotContent) } : { path: relativePath, exists: false, isDirectory: false, sizeBytes: 0 };
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
