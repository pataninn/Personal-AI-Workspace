import type { AiRun } from '@/modules/ai-runs/domain/ai-run-types';
import type { CommandResult, SandboxCommand } from '@/modules/ai-runs/domain/command-types';
import { InMemorySandboxCommandRepository } from '@/infrastructure/ai-runs/in-memory-sandbox-command-repository';
import { FakeAgentRuntime } from '@/infrastructure/sandbox/fake-agent-runtime';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { ISandboxCommandRepository } from '@/modules/ai-runs/repositories/sandbox-command-repository';
import { CancelSandboxCommandUseCase, DecideSandboxCommandUseCase, GetSandboxCommandUseCase, ListSandboxCommandsUseCase, ProposeSandboxCommandUseCase } from '@/modules/ai-runs/use-cases/sandbox-command-use-cases';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

class ReadyRunRepository implements IAiRunRepository {
  public readonly run: AiRun = {
    id: RUN_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    conversationId: '44444444-4444-4444-8444-444444444444',
    request: 'inspect',
    relativeRoot: 'project',
    storageKind: 'legacy',
    requestedPaths: [],
    manifest: {
      manifestHash: 'a'.repeat(64),
      provider: 'NVIDIA hosted NIM',
      providerProfile: 'nvidia-hosted-nim',
      model: 'nvidia/nemotron-3-super-120b-a12b',
      categories: ['Request'],
      files: [],
      requestBytes: 7,
      messageBytes: 0,
      messageCount: 0,
      messageHash: 'b'.repeat(64),
      byteEstimate: 7,
      tokenEstimate: 2,
      excludedItemCount: 0,
      omittedItemCount: 0,
      omissionSummary: 'No selected items were excluded or omitted.',
      bestEffortSecretDetection: true
    },
    manifestInvalidated: false,
    status: 'ready',
    phase: 'runtime',
    decision: 'approved',
    cleanup: 'not_started',
    providerTransmission: 'not_started_confirmed',
    stagingItemCount: 0,
    runtimeKind: 'fake',
    sandboxReady: true,
    safeMessage: 'Ready',
    createdAt: new Date('2026-09-16T00:00:00.000Z'),
    updatedAt: new Date('2026-09-16T00:00:00.000Z')
  };

  public async create(): Promise<never> { throw new Error('Not used'); }
  public async findByIdForOwner(ownerId: string, runId: string): Promise<AiRun | null> { return ownerId === OWNER_ID && runId === RUN_ID ? this.run : null; }
  public async recordDecision(): Promise<never> { throw new Error('Not used'); }
  public async save(): Promise<void> { return undefined; }
  public async beginStart(): Promise<{ readonly resource: AiRun; readonly replayed: boolean }> { throw new Error('Not used'); }
  public async abortStart(): Promise<boolean> { return false; }
}

class ProjectRepositoryFixture implements IProjectRepository {
  public status: Project['status'] = 'active';
  public relativeRoot: string | null = 'project';
  private readonly project: Project = {
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    name: 'Project',
    slug: 'project',
    relativeRoot: this.relativeRoot,
    storageKind: 'legacy',
    objective: null,
    status: 'active',
    version: 1,
    createdAt: new Date('2026-09-16T00:00:00.000Z'),
    updatedAt: new Date('2026-09-16T00:00:00.000Z')
  };

  public async listByOwner(): Promise<readonly Project[]> { return [{ ...this.project, status: this.status }]; }
  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> {
    return ownerId === OWNER_ID && projectId === PROJECT_ID ? { ...this.project, relativeRoot: this.relativeRoot, status: this.status } : null;
  }
  public async listActiveRoots(): Promise<readonly string[]> { return this.status === 'active' ? ['project'] : []; }
  public async create(): Promise<Project> { return { ...this.project, status: this.status }; }
  public async updateStatus(): Promise<Project | null> { return { ...this.project, status: this.status }; }
}

class AvailabilityGateRuntime extends FakeAgentRuntime {
  public readonly availabilityStarted: Promise<void>;
  private releaseAvailability!: () => void;
  private resolveAvailabilityStarted!: () => void;

  public constructor() {
    super();
    this.availabilityStarted = new Promise<void>((resolve) => { this.resolveAvailabilityStarted = resolve; });
  }

  public override async checkAvailability(): Promise<void> {
    this.resolveAvailabilityStarted();
    await new Promise<void>((resolve) => { this.releaseAvailability = resolve; });
  }

  public release(): void {
    this.releaseAvailability();
  }
}

class ProposalFailureRuntime extends FakeAgentRuntime {
  public override async proposeCommand(): Promise<void> {
    throw new Error('runtime proposal failed');
  }
}

class PausingResultRepository extends InMemorySandboxCommandRepository {
  public readonly resultSaveStarted: Promise<void>;
  private resolveResultSaveStarted!: () => void;
  private releaseResultSave!: () => void;

  public constructor() {
    super();
    this.resultSaveStarted = new Promise<void>((resolve) => { this.resolveResultSaveStarted = resolve; });
  }

  public override async saveExecutionResult(input: Parameters<InMemorySandboxCommandRepository['saveExecutionResult']>[0]): ReturnType<InMemorySandboxCommandRepository['saveExecutionResult']> {
    this.resolveResultSaveStarted();
    await new Promise<void>((resolve) => { this.releaseResultSave = resolve; });
    return super.saveExecutionResult(input);
  }

  public release(): void {
    this.releaseResultSave();
  }
}

class FailingResultRepository extends InMemorySandboxCommandRepository {
  public override async saveExecutionResult(): Promise<null> {
    throw new Error('result persistence failed');
  }
}

async function createFixture(): Promise<{ readonly repository: InMemorySandboxCommandRepository; readonly runtime: FakeAgentRuntime; readonly runRepository: ReadyRunRepository; readonly projectRepository: ProjectRepositoryFixture; readonly proposal: SandboxCommand }> {
  const runRepository = new ReadyRunRepository();
  const projectRepository = new ProjectRepositoryFixture();
  const repository = new InMemorySandboxCommandRepository();
  const runtime = new FakeAgentRuntime();
  const propose = new ProposeSandboxCommandUseCase(runRepository, repository, runtime, projectRepository);
  const result = await propose.execute({ ownerId: OWNER_ID, runId: RUN_ID, command: 'rg', args: ['TODO', 'src'], idempotencyKey: 'proposal-1' });
  return { repository, runtime, runRepository, projectRepository, proposal: result.resource };
}

describe('sandbox command use cases', () => {
  it('persists the exact approval before invoking the fake runtime', async () => {
    const fixture = await createFixture();
    const decide = new DecideSandboxCommandUseCase(fixture.runRepository, fixture.repository, fixture.runtime, fixture.projectRepository);

    const result = await decide.execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: fixture.proposal.id, proposalHash: fixture.proposal.proposalHash, decision: 'approve', idempotencyKey: 'decision-1' });

    expect(result.status).toBe('completed');
    expect(fixture.runtime.executedCommands).toHaveLength(1);
    await expect(new GetSandboxCommandUseCase(fixture.runRepository, fixture.repository, fixture.projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: fixture.proposal.id })).resolves.toMatchObject({ status: 'completed', decision: 'approved' });
  });

  it('rejects without a runtime call and blocks stale hashes', async () => {
    const fixture = await createFixture();
    const decide = new DecideSandboxCommandUseCase(fixture.runRepository, fixture.repository, fixture.runtime, fixture.projectRepository);

    await expect(decide.execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: fixture.proposal.id, proposalHash: 'c'.repeat(64), decision: 'approve', idempotencyKey: 'decision-stale' })).rejects.toMatchObject({ code: 'COMMAND_PROPOSAL_CONFLICT' });
    const rejected = await decide.execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: fixture.proposal.id, proposalHash: fixture.proposal.proposalHash, decision: 'reject', idempotencyKey: 'decision-reject' });

    expect(rejected.status).toBe('rejected');
    expect(fixture.runtime.executedCommands).toHaveLength(0);
  });

  it('persists blocked proposals and never allows approval to execute them', async () => {
    const runRepository = new ReadyRunRepository();
    const projectRepository = new ProjectRepositoryFixture();
    const repository = new InMemorySandboxCommandRepository();
    const runtime = new FakeAgentRuntime();
    const propose = new ProposeSandboxCommandUseCase(runRepository, repository, runtime, projectRepository);
    const blocked = await propose.execute({ ownerId: OWNER_ID, runId: RUN_ID, command: 'powershell', args: ['Get-ChildItem'], idempotencyKey: 'proposal-blocked' });
    const decide = new DecideSandboxCommandUseCase(runRepository, repository, runtime, projectRepository);

    await expect(decide.execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: blocked.resource.id, proposalHash: blocked.resource.proposalHash, decision: 'approve', idempotencyKey: 'decision-blocked' })).rejects.toMatchObject({ code: 'COMMAND_BLOCKED' });
    expect(runtime.executedCommands).toHaveLength(0);
  });

  it('requests best-effort cancellation and ignores a late runtime result', async () => {
    const fixture = await createFixture();
    fixture.runtime.commandOptions = { delayMs: 20 };
    const decide = new DecideSandboxCommandUseCase(fixture.runRepository, fixture.repository, fixture.runtime, fixture.projectRepository);
    const cancel = new CancelSandboxCommandUseCase(fixture.runRepository, fixture.repository, fixture.runtime, fixture.projectRepository);
    const approval = decide.execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: fixture.proposal.id, proposalHash: fixture.proposal.proposalHash, decision: 'approve', idempotencyKey: 'decision-cancel' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const pending = await cancel.execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: fixture.proposal.id, idempotencyKey: 'cancel-1' });
    expect(pending.status).toBe('cancel_requested');
    await approval;
    const cancelled = await new GetSandboxCommandUseCase(fixture.runRepository, fixture.repository, fixture.projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: fixture.proposal.id });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.result).toBeUndefined();
  });

  it('redacts, strips ANSI, and caps runtime output before persistence', async () => {
    const fixture = await createFixture();
    const unsafeResult: CommandResult = {
      exitCode: 0,
      termination: 'completed',
      durationMs: 99_999,
      outputBytes: 99_999,
      outputLineCount: 2,
      outputTruncated: false,
      outputSha256: 'd'.repeat(64),
      outputPreview: `\u001b[31mAPI_KEY=secret-value\u001b[0m${'x'.repeat(10_000)}`
    };
    fixture.runtime.commandOptions = { nextResult: unsafeResult };
    const decide = new DecideSandboxCommandUseCase(fixture.runRepository, fixture.repository, fixture.runtime, fixture.projectRepository);

    const result = await decide.execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: fixture.proposal.id, proposalHash: fixture.proposal.proposalHash, decision: 'approve', idempotencyKey: 'decision-output' });

    expect(result.status).toBe('output_truncated');
    expect(result.result?.outputPreview).not.toContain('\u001b');
    expect(result.result?.outputPreview).not.toContain('secret-value');
    expect(Buffer.byteLength(result.result?.outputPreview ?? '', 'utf8')).toBeLessThanOrEqual(4 * 1024);
  });

  it('does not start execution when cancellation wins during availability preflight', async () => {
    const runRepository = new ReadyRunRepository();
    const projectRepository = new ProjectRepositoryFixture();
    const repository = new InMemorySandboxCommandRepository();
    const runtime = new AvailabilityGateRuntime();
    const proposal = await new ProposeSandboxCommandUseCase(runRepository, repository, runtime, projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID, command: 'pwd', args: [], idempotencyKey: 'proposal-preflight' });
    const approve = new DecideSandboxCommandUseCase(runRepository, repository, runtime, projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: proposal.resource.id, proposalHash: proposal.resource.proposalHash, decision: 'approve', idempotencyKey: 'decision-preflight' });
    await runtime.availabilityStarted;

    const cancellation = await new CancelSandboxCommandUseCase(runRepository, repository, runtime, projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: proposal.resource.id, idempotencyKey: 'cancel-preflight' });
    runtime.release();
    await approve;

    expect(cancellation.status).toBe('cancelled');
    expect(runtime.executedCommands).toHaveLength(0);
  });

  it('keeps cancellation ahead of a late result when result persistence is interleaved', async () => {
    const runRepository = new ReadyRunRepository();
    const projectRepository = new ProjectRepositoryFixture();
    const repository = new PausingResultRepository();
    const runtime = new FakeAgentRuntime();
    const proposal = await new ProposeSandboxCommandUseCase(runRepository, repository, runtime, projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID, command: 'pwd', args: [], idempotencyKey: 'proposal-late-result' });
    const approve = new DecideSandboxCommandUseCase(runRepository, repository, runtime, projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: proposal.resource.id, proposalHash: proposal.resource.proposalHash, decision: 'approve', idempotencyKey: 'decision-late-result' });
    await repository.resultSaveStarted;
    const cancellation = new CancelSandboxCommandUseCase(runRepository, repository, runtime, projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: proposal.resource.id, idempotencyKey: 'cancel-late-result' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    repository.release();

    await approve;
    expect((await cancellation).status).toBe('cancel_requested');
    const current = await new GetSandboxCommandUseCase(runRepository, repository, projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: proposal.resource.id });
    expect(current.status).toBe('cancelled');
    expect(current.result).toBeUndefined();
  });

  it('returns review-required when result persistence fails without retrying execution', async () => {
    const runRepository = new ReadyRunRepository();
    const projectRepository = new ProjectRepositoryFixture();
    const repository = new FailingResultRepository();
    const runtime = new FakeAgentRuntime();
    const messages: string[] = [];
    const proposal = await new ProposeSandboxCommandUseCase(runRepository, repository, runtime, projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID, command: 'pwd', args: [], idempotencyKey: 'proposal-persist-failure' });
    const decide = new DecideSandboxCommandUseCase(runRepository, repository, runtime, projectRepository, { error: (_context, message) => messages.push(message) });

    const result = await decide.execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: proposal.resource.id, proposalHash: proposal.resource.proposalHash, decision: 'approve', idempotencyKey: 'decision-persist-failure' });

    expect(result.status).toBe('review_required');
    expect(runtime.executedCommands).toHaveLength(1);
    expect(messages).toContain('Sandbox command result persistence failed; manual review is required.');
  });

  it('fails closed when the server-owned runtime proposal handoff fails', async () => {
    const runRepository = new ReadyRunRepository();
    const projectRepository = new ProjectRepositoryFixture();
    const repository = new InMemorySandboxCommandRepository();
    const runtime = new ProposalFailureRuntime();
    const proposal = new ProposeSandboxCommandUseCase(runRepository, repository, runtime, projectRepository);

    await expect(proposal.execute({ ownerId: OWNER_ID, runId: RUN_ID, command: 'pwd', args: [], idempotencyKey: 'proposal-runtime-failure' })).rejects.toThrow('runtime proposal failed');
    const commands = await new ListSandboxCommandsUseCase(runRepository, repository, projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID });
    expect(commands[0]?.status).toBe('review_required');
  });

  it('requires an owner-scoped run for list and single-command queries', async () => {
    const repository = new InMemorySandboxCommandRepository();
    const runRepository = new ReadyRunRepository();
    const projectRepository = new ProjectRepositoryFixture();
    const proposal = await new ProposeSandboxCommandUseCase(runRepository, repository, new FakeAgentRuntime(), projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID, command: 'pwd', args: [], idempotencyKey: 'proposal-scope' });
    const list = new ListSandboxCommandsUseCase(runRepository, repository, projectRepository);

    await expect(list.execute({ ownerId: OWNER_ID, runId: '99999999-9999-4999-8999-999999999999' })).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' });
    await expect(new GetSandboxCommandUseCase(runRepository, repository, projectRepository).execute({ ownerId: '99999999-9999-4999-8999-999999999999', runId: RUN_ID, commandId: proposal.resource.id })).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' });
  });

  it('refuses list and single-command history for a planning project before repository reads', async () => {
    const runRepository = new ReadyRunRepository();
    const projectRepository = new ProjectRepositoryFixture();
    projectRepository.relativeRoot = null;
    const listForRun = jest.fn();
    const findByIdForOwner = jest.fn();
    const repository = { listForRun, findByIdForOwner } as unknown as ISandboxCommandRepository;

    await expect(new ListSandboxCommandsUseCase(runRepository, repository, projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID }))
      .rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED', statusCode: 409 });
    await expect(new GetSandboxCommandUseCase(runRepository, repository, projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: '66666666-6666-4666-8666-666666666666' }))
      .rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED', statusCode: 409 });

    expect(listForRun).not.toHaveBeenCalled();
    expect(findByIdForOwner).not.toHaveBeenCalled();
  });

  it('blocks approval and cancellation after the project is archived', async () => {
    const fixture = await createFixture();
    fixture.projectRepository.status = 'archived';
    const decide = new DecideSandboxCommandUseCase(fixture.runRepository, fixture.repository, fixture.runtime, fixture.projectRepository);
    const cancel = new CancelSandboxCommandUseCase(fixture.runRepository, fixture.repository, fixture.runtime, fixture.projectRepository);

    await expect(decide.execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: fixture.proposal.id, proposalHash: fixture.proposal.proposalHash, decision: 'approve', idempotencyKey: 'decision-archived' })).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
    await expect(cancel.execute({ ownerId: OWNER_ID, runId: RUN_ID, commandId: fixture.proposal.id, idempotencyKey: 'cancel-archived' })).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
    expect(fixture.runtime.executedCommands).toHaveLength(0);
  });

  it('bounds command listings at the server-side limit', async () => {
    const runRepository = new ReadyRunRepository();
    const projectRepository = new ProjectRepositoryFixture();
    const repository = new InMemorySandboxCommandRepository();
    const runtime = new FakeAgentRuntime();
    const propose = new ProposeSandboxCommandUseCase(runRepository, repository, runtime, projectRepository);

    for (let index = 0; index < 105; index += 1) {
      await propose.execute({ ownerId: OWNER_ID, runId: RUN_ID, command: 'pwd', args: [], idempotencyKey: `proposal-list-${index}` });
    }

    const commands = await new ListSandboxCommandsUseCase(runRepository, repository, projectRepository).execute({ ownerId: OWNER_ID, runId: RUN_ID });
    expect(commands).toHaveLength(100);
  });
});
