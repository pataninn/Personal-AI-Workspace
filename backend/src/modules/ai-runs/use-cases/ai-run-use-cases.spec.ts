import type { Conversation, Message, MessagePage } from '@/modules/conversations/domain/conversation-types';
import type { IConversationRepository, FindConversationInput } from '@/modules/conversations/repositories/conversation-repository';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import type { WorkspaceReadResult } from '@/modules/files/domain/workspace-types';
import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { AiRun } from '@/modules/ai-runs/domain/ai-run-types';
import type { IAgentRuntime } from '@/modules/ai-runs/repositories/agent-runtime';
import type { IStagingGateway, StageInput } from '@/modules/ai-runs/repositories/staging-gateway';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import { InMemoryAiRunRepository } from '@/infrastructure/ai-runs/in-memory-ai-run-repository';
import { CreateAiRunUseCase, DecideEgressUseCase } from '@/modules/ai-runs/use-cases/ai-run-use-cases';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const FACT_ID = '55555555-5555-4555-8555-555555555555';

function makeProject(): Project {
  const now = new Date('2026-09-16T00:00:00.000Z');
  return { id: PROJECT_ID, ownerId: OWNER_ID, name: 'Project', slug: 'project', relativeRoot: 'project', status: 'active', version: 1, createdAt: now, updatedAt: now };
}

function makeConversation(): MessagePage {
  const now = new Date('2026-09-16T00:00:00.000Z');
  const conversation: Conversation = { id: CONVERSATION_ID, ownerId: OWNER_ID, projectId: PROJECT_ID, title: 'Chat', status: 'active', lastActivityAt: now, createdAt: now, updatedAt: now };
  const message: Message = { id: '44444444-4444-4444-8444-444444444444', conversationId: CONVERSATION_ID, role: 'user', sequence: 1, content: 'Earlier context', createdAt: now };
  return { conversation, messages: [message], nextBeforeSequence: null };
}

function makeFact(overrides: Partial<ProjectFact> = {}): ProjectFact {
  const now = new Date('2026-09-16T00:00:00.000Z');
  return {
    id: FACT_ID,
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    key: 'test command',
    title: 'Test command',
    content: 'Run pnpm test.',
    source: { kind: 'user', label: 'Added by you', reference: null },
    version: 1,
    verifiedAt: null,
    verificationStatus: 'needs_review',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function factRepository(options: { readonly facts?: readonly ProjectFact[] } = {}): jest.Mocked<IProjectFactRepository> {
  const selectedFacts = options.facts ?? [makeFact()];
  return {
    listActiveByProject: jest.fn().mockResolvedValue(selectedFacts),
    findActiveById: jest.fn().mockImplementation(async (_ownerId: string, _projectId: string, factId: string) => selectedFacts.find((fact) => fact.id === factId) ?? null),
    findActiveByIds: jest.fn().mockImplementation(async (ownerId: string, projectId: string, factIds: readonly string[]) => selectedFacts.filter((fact) => fact.ownerId === ownerId && fact.projectId === projectId && factIds.includes(fact.id))),
    create: jest.fn(),
    update: jest.fn(),
    verify: jest.fn(),
    softDelete: jest.fn()
  } as unknown as jest.Mocked<IProjectFactRepository>;
}

class ProjectFixture implements IProjectRepository {
  public async listByOwner(): Promise<readonly Project[]> { return [makeProject()]; }
  public async findByIdForOwner(): Promise<Project | null> { return makeProject(); }
  public async listActiveRoots(): Promise<readonly string[]> { return ['project']; }
  public async create(): Promise<Project> { return makeProject(); }
  public async updateStatus(): Promise<Project | null> { return makeProject(); }
}

class ConversationFixture implements IConversationRepository {
  public async listByProjectForOwner(): Promise<never> { throw new Error('Not used'); }
  public async findWithMessagesForOwner(_input: FindConversationInput): Promise<MessagePage> { return makeConversation(); }
  public async create(): Promise<never> { throw new Error('Not used'); }
  public async addUserMessage(): Promise<never> { throw new Error('Not used'); }
}

class WorkspaceFixture implements IWorkspaceGateway {
  public changed = false;

  public async list(): Promise<never> { throw new Error('Not used'); }
  public async tree(): Promise<never> { throw new Error('Not used'); }
  public async searchText(): Promise<never> { throw new Error('Not used'); }
  public async readText(_scope: unknown, input: { readonly path: string }): Promise<WorkspaceReadResult> {
    if (this.changed) {
      return { path: input.path, content: 'changed', encoding: 'utf-8', sizeBytes: 7, lineCount: 1, truncated: false };
    }
    return { path: input.path, content: 'const answer = 42;\n', encoding: 'utf-8', sizeBytes: 20, lineCount: 1, truncated: false };
  }
}

class RuntimeFixture implements IAgentRuntime {
  public available = true;
  public readonly created: string[] = [];

  public async checkAvailability(): Promise<void> {
    if (!this.available) {
      throw new AiRunRuntimeUnavailableError();
    }
  }

  public async create(input: { readonly runId: string; readonly stagedReference: string; readonly manifest: AiRun['manifest'] }): Promise<{ readonly kind: 'fake'; readonly sandboxReady: true }> {
    this.created.push(input.runId);
    return { kind: 'fake', sandboxReady: true };
  }

  public async destroy(): Promise<void> { return undefined; }
}

class StagingFixture implements IStagingGateway {
  public readonly staged: StageInput[] = [];
  public async stage(input: StageInput): Promise<{ readonly stagingReference: string; readonly itemCount: number }> {
    this.staged.push(input);
    return { stagingReference: `fake://${input.runId}`, itemCount: input.files.length + 1 };
  }
  public async cleanup(): Promise<void> { return undefined; }
}

describe('AI run use cases', () => {
  it('builds a metadata-only manifest without staging or runtime calls', async () => {
    const workspace = new WorkspaceFixture();
    const staging = new StagingFixture();
    const runtime = new RuntimeFixture();
    const repository = new InMemoryAiRunRepository();
    const useCase = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');

    const result = await useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Inspect the source', relativePaths: ['src/index.ts'], includeRecentMessages: true, idempotencyKey: 'create-run-1' });

    expect(result.resource.manifest.files[0]).toMatchObject({ relativePath: 'src/index.ts', sizeBytes: 20 });
    expect(result.resource.manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(staging.staged).toHaveLength(0);
    expect(runtime.created).toHaveLength(0);
  });

  it('rejects credential-like request values before creating a durable run', async () => {
    const repository = new InMemoryAiRunRepository();
    const useCase = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), new WorkspaceFixture(), repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');

    await expect(useCase.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Use NVIDIA_API_KEY=secret-value-123', relativePaths: [], includeRecentMessages: false, idempotencyKey: 'create-run-secret' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(repository.findByIdForOwner(OWNER_ID, '00000000-0000-4000-8000-000000000000')).resolves.toBeNull();
  });

  it('rejects without staging or runtime activity', async () => {
    const repository = new InMemoryAiRunRepository();
    const workspace = new WorkspaceFixture();
    const runtime = new RuntimeFixture();
    const staging = new StagingFixture();
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Keep local', relativePaths: [], includeRecentMessages: false, idempotencyKey: 'create-run-2' });
    const decide = new DecideEgressUseCase(repository, new ConversationFixture(), workspace, staging, runtime, '/workspace');

    const result = await decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash, decision: 'reject', idempotencyKey: 'decision-2' });

    expect(result.status).toBe('rejected');
    expect(staging.staged).toHaveLength(0);
    expect(runtime.created).toHaveLength(0);
  });

  it('records approval before staging and runtime readiness', async () => {
    const repository = new InMemoryAiRunRepository();
    const workspace = new WorkspaceFixture();
    const runtime = new RuntimeFixture();
    const staging = new StagingFixture();
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Prepare a private run', relativePaths: ['src/index.ts'], includeRecentMessages: false, idempotencyKey: 'create-run-3' });
    const decide = new DecideEgressUseCase(repository, new ConversationFixture(), workspace, staging, runtime, '/workspace');

    const result = await decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash, decision: 'approve', idempotencyKey: 'decision-3' });

    expect(result.status).toBe('ready');
    expect(staging.staged).toHaveLength(1);
    expect(runtime.created).toEqual([created.resource.id]);
    expect((await repository.findByIdForOwner(OWNER_ID, created.resource.id))?.decision).toBe('approved');
  });

  it('carries the same bounded recent-message snapshot into staging after approval', async () => {
    const repository = new InMemoryAiRunRepository();
    const workspace = new WorkspaceFixture();
    const runtime = new RuntimeFixture();
    const staging = new StagingFixture();
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Use bounded conversation context', relativePaths: ['src/index.ts', 'src\\index.ts'], includeRecentMessages: true, idempotencyKey: 'create-run-messages' });
    const decide = new DecideEgressUseCase(repository, new ConversationFixture(), workspace, staging, runtime, '/workspace');

    await expect(decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash, decision: 'approve', idempotencyKey: 'decision-messages' })).resolves.toMatchObject({ status: 'ready' });

    expect(created.resource.manifest.files).toHaveLength(1);
    expect(staging.staged[0]?.messages).toEqual([{ role: 'user', content: 'Earlier context' }]);
  });

  it('fails closed before staging when the runtime is unavailable', async () => {
    const repository = new InMemoryAiRunRepository();
    const workspace = new WorkspaceFixture();
    const runtime = new RuntimeFixture();
    runtime.available = false;
    const staging = new StagingFixture();
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Unavailable gateway', relativePaths: ['src/index.ts'], includeRecentMessages: false, idempotencyKey: 'create-run-4' });
    const decide = new DecideEgressUseCase(repository, new ConversationFixture(), workspace, staging, runtime, '/workspace');

    await expect(decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash, decision: 'approve', idempotencyKey: 'decision-4' })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    expect(staging.staged).toHaveLength(0);
    expect((await repository.findByIdForOwner(OWNER_ID, created.resource.id))?.status).toBe('failed');
  });

  it('invalidates the approved run when a selected source changes before staging', async () => {
    const repository = new InMemoryAiRunRepository();
    const workspace = new WorkspaceFixture();
    const runtime = new RuntimeFixture();
    const staging = new StagingFixture();
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Recheck the source', relativePaths: ['src/index.ts'], includeRecentMessages: false, idempotencyKey: 'create-run-5' });
    workspace.changed = true;
    const decide = new DecideEgressUseCase(repository, new ConversationFixture(), workspace, staging, runtime, '/workspace');

    await expect(decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash, decision: 'approve', idempotencyKey: 'decision-5' })).rejects.toMatchObject({ code: 'EGRESS_SOURCE_CHANGED' });
    expect(staging.staged).toHaveLength(0);
    expect(runtime.created).toHaveLength(0);
    expect((await repository.findByIdForOwner(OWNER_ID, created.resource.id))?.status).toBe('failed');
    expect((await repository.findByIdForOwner(OWNER_ID, created.resource.id))?.manifestInvalidated).toBe(true);
  });

  it('includes only explicitly selected fact snapshots in the provider disclosure', async () => {
    const repository = new InMemoryAiRunRepository();
    const factRecords = factRepository();
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), new WorkspaceFixture(), repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b', factRecords);
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Use the test command', factIds: [FACT_ID, FACT_ID], relativePaths: [], includeRecentMessages: false, idempotencyKey: 'create-run-fact-context' });

    expect(factRecords.findActiveByIds).toHaveBeenCalledWith(OWNER_ID, PROJECT_ID, [FACT_ID]);
    expect(created.resource.manifest.categories).toContain('Project facts');
    expect(created.resource.manifest.facts).toEqual([expect.objectContaining({
      id: FACT_ID,
      title: 'Test command',
      content: 'Run pnpm test.',
      source: { kind: 'user', label: 'Added by you', reference: null },
      version: 1,
      verificationStatus: 'needs_review'
    })]);
    expect(created.resource.manifest.byteEstimate).toBeGreaterThan(Buffer.byteLength('Use the test command', 'utf8'));
  });

  it('rejects missing or foreign project facts without creating a run', async () => {
    const repository = new InMemoryAiRunRepository();
    const factRecords = factRepository({ facts: [] });
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), new WorkspaceFixture(), repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b', factRecords);

    await expect(create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Use a fact', factIds: [FACT_ID], relativePaths: [], includeRecentMessages: false, idempotencyKey: 'create-run-missing-fact' }))
      .rejects.toMatchObject({ code: 'PROJECT_FACT_NOT_FOUND' });
    expect(await repository.findByIdForOwner(OWNER_ID, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('invalidates the manifest before recording consent if a selected fact drifts', async () => {
    const repository = new InMemoryAiRunRepository();
    const workspace = new WorkspaceFixture();
    const runtime = new RuntimeFixture();
    const staging = new StagingFixture();
    let currentFact = makeFact();
    const factRecords = factRepository();
    factRecords.findActiveByIds.mockImplementation(async (ownerId, projectId, factIds) => currentFact.ownerId === ownerId && currentFact.projectId === projectId && factIds.includes(currentFact.id) ? [currentFact] : []);
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b', factRecords);
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Use the saved test command', factIds: [FACT_ID], relativePaths: [], includeRecentMessages: false, idempotencyKey: 'create-run-stale-fact' });
    currentFact = makeFact({ version: 2, content: 'Run pnpm test --run.', updatedAt: new Date('2026-09-17T00:00:00.000Z') });
    const decide = new DecideEgressUseCase(repository, new ConversationFixture(), workspace, staging, runtime, '/workspace', factRecords);

    await expect(decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash, decision: 'approve', idempotencyKey: 'decision-stale-fact' }))
      .rejects.toMatchObject({ code: 'EGRESS_SOURCE_CHANGED' });
    const invalidated = await repository.findByIdForOwner(OWNER_ID, created.resource.id);
    expect(invalidated).toMatchObject({ status: 'failed', decision: 'pending', manifestInvalidated: true, providerTransmission: 'not_started_confirmed' });
    expect(runtime.created).toHaveLength(0);
    expect(staging.staged).toHaveLength(0);
  });
});
