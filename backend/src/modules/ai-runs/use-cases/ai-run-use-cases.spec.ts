import type { Conversation, Message, MessagePage } from '@/modules/conversations/domain/conversation-types';
import type { IConversationRepository, FindConversationInput } from '@/modules/conversations/repositories/conversation-repository';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import type { WorkspaceReadResult } from '@/modules/files/domain/workspace-types';
import { AiRunRuntimeUnavailableError, AiRunStateConflictError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { AiRun } from '@/modules/ai-runs/domain/ai-run-types';
import type { IAgentRuntime } from '@/modules/ai-runs/repositories/agent-runtime';
import type { IStagingGateway, StageInput } from '@/modules/ai-runs/repositories/staging-gateway';
import type { ProjectFact } from '@/modules/memory/domain/project-fact';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import type { IProviderPermissionRepository } from '@/modules/ai-runs/repositories/provider-permission-repository';
import { InMemoryAiRunRepository } from '@/infrastructure/ai-runs/in-memory-ai-run-repository';
import { InMemoryProviderPermissionRepository } from '@/infrastructure/ai-runs/in-memory-provider-permission-repository';
import { InMemoryRunEventPublisher } from '@/infrastructure/ai-runs/in-memory-run-event-publisher';
import { CreateAiRunUseCase, DecideEgressUseCase, GetAiRunUseCase } from '@/modules/ai-runs/use-cases/ai-run-use-cases';
import { StartAiRunUseCase } from '@/modules/ai-runs/use-cases/start-ai-run-use-case';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const FACT_ID = '55555555-5555-4555-8555-555555555555';

function makeProject(): Project {
  const now = new Date('2026-09-16T00:00:00.000Z');
  return { id: PROJECT_ID, ownerId: OWNER_ID, name: 'Project', slug: 'project', relativeRoot: 'project', objective: null, status: 'active', version: 1, createdAt: now, updatedAt: now };
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
  public status: Project['status'] = 'active';
  public async listByOwner(): Promise<readonly Project[]> { return [makeProject()]; }
  public async findByIdForOwner(): Promise<Project | null> { return { ...makeProject(), status: this.status }; }
  public async listActiveRoots(): Promise<readonly string[]> { return ['project']; }
  public async create(): Promise<Project> { return makeProject(); }
  public async updateStatus(): Promise<Project | null> { return makeProject(); }
}

class RootlessProjectFixture extends ProjectFixture {
  public override async findByIdForOwner(): Promise<Project | null> { return { ...makeProject(), relativeRoot: null }; }
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
  it('refuses to create an assistant run for a planning project before conversation or workspace reads', async () => {
    const conversations = new ConversationFixture();
    const findConversation = jest.spyOn(conversations, 'findWithMessagesForOwner');
    const workspace = new WorkspaceFixture();
    const workspaceRead = jest.spyOn(workspace, 'readText');
    const repository = new InMemoryAiRunRepository();
    const create = new CreateAiRunUseCase(new RootlessProjectFixture(), conversations, workspace, repository, 'nvidia-hosted-nim', 'test-model');

    await expect(create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Plan the launch', relativePaths: [], includeRecentMessages: false, idempotencyKey: 'planning-no-run' }))
      .rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED', statusCode: 409 });
    expect(findConversation).not.toHaveBeenCalled();
    expect(workspaceRead).not.toHaveBeenCalled();
    await expect(repository.findByIdForOwner(OWNER_ID, '00000000-0000-4000-8000-000000000000')).resolves.toBeNull();
  });

  it('hides an existing run manifest when its project is planning-only', async () => {
    const repository = new InMemoryAiRunRepository();
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), new WorkspaceFixture(), repository, 'nvidia-hosted-nim', 'test-model');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Inspect project files', relativePaths: [], includeRecentMessages: false, idempotencyKey: 'get-rootless-run-create' });
    const getRun = new GetAiRunUseCase(repository, new RootlessProjectFixture());

    await expect(getRun.execute({ ownerId: OWNER_ID, runId: created.resource.id })).rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED', statusCode: 409 });
  });

  it('continues to allow reads for rooted archived projects', async () => {
    const repository = new InMemoryAiRunRepository();
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), new WorkspaceFixture(), repository, 'nvidia-hosted-nim', 'test-model');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Inspect project files', relativePaths: [], includeRecentMessages: false, idempotencyKey: 'get-archived-run-create' });
    const archivedProjects = new ProjectFixture();
    archivedProjects.status = 'archived';

    await expect(new GetAiRunUseCase(repository, archivedProjects).execute({ ownerId: OWNER_ID, runId: created.resource.id })).resolves.toEqual(created.resource);
  });
  it('freezes previous-project messages before saving the new user message so preparing context remains stable', async () => {
    const repository = new InMemoryAiRunRepository();
    const conversations = new ConversationFixture();
    const original = makeConversation();
    let messages = [...original.messages];
    const previous = { ...original.messages[0], id: 'previous-message', conversationId: 'previous-conversation', content: 'Earlier project discussion' };
    const findRecent = jest.fn().mockResolvedValue([previous, ...messages]);
    const addMessage = jest.fn(async () => {
      const message: Message = { id: 'new-request', conversationId: CONVERSATION_ID, role: 'user', sequence: 2, content: 'Continue the discussion', createdAt: new Date() };
      messages = [...messages, message];
      return { resource: message, replayed: false };
    });
    const history: IConversationRepository = { ...conversations,
      listByProjectForOwner: jest.fn(), create: jest.fn(), addUserMessage: jest.fn(),
      findWithMessagesForOwner: jest.fn(async () => ({ ...original, messages })),
      findRecentMessagesByProjectForOwner: findRecent, addRunUserMessage: addMessage };
    const workspace = new WorkspaceFixture();
    const staging = new StagingFixture();
    const create = new CreateAiRunUseCase(new ProjectFixture(), history, workspace, repository, 'nvidia-hosted-nim', 'test-model');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID,
      request: 'Continue the discussion', relativePaths: [], includeRecentMessages: true, includeProjectConversations: true, idempotencyKey: 'previous-project-context' });
    const decide = new DecideEgressUseCase(repository, new ProjectFixture(), history, workspace, staging, new RuntimeFixture(), '/workspace');
    await expect(decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash,
      decision: 'approve', idempotencyKey: 'stable-context-approval' })).resolves.toMatchObject({ status: 'ready' });
    expect(findRecent).toHaveBeenCalledWith({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, limit: 20 });
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(staging.staged[0]?.messages).toEqual([{ role: 'user', content: 'Earlier project discussion' }, { role: 'user', content: 'Earlier context' }]);
  });
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
    const decide = new DecideEgressUseCase(repository, new ProjectFixture(), new ConversationFixture(), workspace, staging, runtime, '/workspace');

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
    const decide = new DecideEgressUseCase(repository, new ProjectFixture(), new ConversationFixture(), workspace, staging, runtime, '/workspace');

    const result = await decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash, decision: 'approve', idempotencyKey: 'decision-3' });

    expect(result.status).toBe('ready');
    expect(staging.staged).toHaveLength(1);
    expect(runtime.created).toEqual([created.resource.id]);
    expect((await repository.findByIdForOwner(OWNER_ID, created.resource.id))?.decision).toBe('approved');
  });

  it('refuses an egress decision for a planning project before conversation, decision, staging, or runtime work', async () => {
    const repository = new InMemoryAiRunRepository();
    const conversations = new ConversationFixture();
    const workspace = new WorkspaceFixture();
    const create = new CreateAiRunUseCase(new ProjectFixture(), conversations, workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Inspect files', relativePaths: [], includeRecentMessages: false, idempotencyKey: 'egress-rootless-create' });
    const recordDecision = jest.spyOn(repository, 'recordDecision');
    const findMessages = jest.spyOn(conversations, 'findWithMessagesForOwner');
    const messageReadCount = findMessages.mock.calls.length;
    const staging = new StagingFixture();
    const runtime = new RuntimeFixture();
    const findPermission = jest.fn();
    const permissions = { findActive: findPermission } as unknown as IProviderPermissionRepository;
    const decide = new DecideEgressUseCase(repository, new RootlessProjectFixture(), conversations, workspace, staging, runtime, '/workspace', undefined, permissions);

    await expect(decide.approveWithRememberedPermission({ ownerId: OWNER_ID, runId: created.resource.id }))
      .rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED', statusCode: 409 });
    expect(findPermission).not.toHaveBeenCalled();

    await expect(decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash, decision: 'approve', idempotencyKey: 'egress-rootless-approve' }))
      .rejects.toMatchObject({ code: 'PROJECT_ROOT_NOT_ATTACHED', statusCode: 409 });
    expect(recordDecision).not.toHaveBeenCalled();
    expect(findMessages).toHaveBeenCalledTimes(messageReadCount);
    expect(staging.staged).toHaveLength(0);
    expect(runtime.created).toHaveLength(0);
  });

  it('grants only this project, the configured provider profile/model, and selected-context sending', async () => {
    const repository = new InMemoryAiRunRepository();
    const permissions = new InMemoryProviderPermissionRepository();
    const workspace = new WorkspaceFixture();
    const runtime = new RuntimeFixture();
    const staging = new StagingFixture();
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');
    const first = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Remember this project scope', relativePaths: [], includeRecentMessages: false, idempotencyKey: 'create-grant-first' });
    const decide = new DecideEgressUseCase(repository, new ProjectFixture(), new ConversationFixture(), workspace, staging, runtime, '/workspace', undefined, permissions);
    const approved = await decide.execute({ ownerId: OWNER_ID, runId: first.resource.id, manifestHash: first.resource.manifest.manifestHash, decision: 'approve', rememberProviderPermission: true, idempotencyKey: 'decision-grant-first' });

    expect(approved.status).toBe('ready');
    expect(approved.providerPermissionId).toBeUndefined();
    expect(await permissions.listForProjectOwner({ ownerId: OWNER_ID, projectId: PROJECT_ID })).toEqual([expect.objectContaining({
      projectId: PROJECT_ID,
      providerProfile: 'nvidia-hosted-nim',
      model: 'nvidia/nemotron-3-super-120b-a12b',
      capability: 'send_selected_context',
      expiresAt: null,
      revokedAt: null
    })]);
    expect(await permissions.findActive({ ownerId: OWNER_ID, projectId: '66666666-6666-4666-8666-666666666666', providerProfile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b' })).toBeNull();
    expect(await permissions.findActive({ ownerId: OWNER_ID, projectId: PROJECT_ID, providerProfile: 'other-provider', model: 'nvidia/nemotron-3-super-120b-a12b' })).toBeNull();
  });

  it('does not create a saved grant when the exact run approval is rejected by the repository', async () => {
    const repository = new InMemoryAiRunRepository();
    const permissions = new InMemoryProviderPermissionRepository();
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), new WorkspaceFixture(), repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Do not create an orphaned grant', relativePaths: [], includeRecentMessages: false, idempotencyKey: 'create-grant-rejected-decision' });
    const grant = jest.spyOn(permissions, 'grant');
    jest.spyOn(repository, 'recordDecision').mockRejectedValue(new AiRunStateConflictError());
    const decide = new DecideEgressUseCase(repository, new ProjectFixture(), new ConversationFixture(), new WorkspaceFixture(), new StagingFixture(), new RuntimeFixture(), '/workspace', undefined, permissions);

    await expect(decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash, decision: 'approve', rememberProviderPermission: true, idempotencyKey: 'decision-grant-rejected' }))
      .rejects.toMatchObject({ code: 'AI_RUN_STATE_CONFLICT' });
    expect(grant).not.toHaveBeenCalled();
    await expect(permissions.listForProjectOwner({ ownerId: OWNER_ID, projectId: PROJECT_ID })).resolves.toEqual([]);
  });

  it('keeps the one-time approval usable and explains when saving the grant fails', async () => {
    const repository = new InMemoryAiRunRepository();
    const permissions = new InMemoryProviderPermissionRepository();
    const workspace = new WorkspaceFixture();
    const runtime = new RuntimeFixture();
    const staging = new StagingFixture();
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Use this one-time approval', relativePaths: [], includeRecentMessages: false, idempotencyKey: 'create-grant-storage-failure' });
    jest.spyOn(permissions, 'grant').mockRejectedValue(new Error('storage unavailable'));
    const decide = new DecideEgressUseCase(repository, new ProjectFixture(), new ConversationFixture(), workspace, staging, runtime, '/workspace', undefined, permissions);

    const result = await decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash, decision: 'approve', rememberProviderPermission: true, idempotencyKey: 'decision-grant-storage-failure' });

    expect(result).toMatchObject({ status: 'ready', decision: 'approved' });
    expect(result.safeMessage).toContain('this approval applies only to this run');
    await expect(permissions.listForProjectOwner({ ownerId: OWNER_ID, projectId: PROJECT_ID })).resolves.toEqual([]);
    expect(staging.staged).toHaveLength(1);
    expect(runtime.created).toEqual([created.resource.id]);
  });

  it('does not let a remembered permission authorize rejection or a provider/model mismatch', async () => {
    const repository = new InMemoryAiRunRepository();
    const permissions = new InMemoryProviderPermissionRepository();
    await permissions.grant({ ownerId: OWNER_ID, projectId: PROJECT_ID, providerProfile: 'other-provider', model: 'other-model' });
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), new WorkspaceFixture(), repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Do not widen provider scope', relativePaths: [], includeRecentMessages: false, idempotencyKey: 'create-grant-mismatch' });
    const decide = new DecideEgressUseCase(repository, new ProjectFixture(), new ConversationFixture(), new WorkspaceFixture(), new StagingFixture(), new RuntimeFixture(), '/workspace', undefined, permissions);

    await expect(decide.approveWithRememberedPermission({ ownerId: OWNER_ID, runId: created.resource.id })).resolves.toBeNull();
    await expect(decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash, decision: 'reject', rememberProviderPermission: true, idempotencyKey: 'decision-grant-mismatch' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await repository.findByIdForOwner(OWNER_ID, created.resource.id)).toMatchObject({ status: 'pending_approval', decision: 'pending' });
    expect(await permissions.listForProjectOwner({ ownerId: OWNER_ID, projectId: PROJECT_ID })).toHaveLength(1);
  });

  it('auto-approves only matching active permissions and reopens consent if the grant is revoked before start', async () => {
    const repository = new InMemoryAiRunRepository();
    const permissions = new InMemoryProviderPermissionRepository();
    const workspace = new WorkspaceFixture();
    const runtime = new RuntimeFixture();
    const staging = new StagingFixture();
    const permission = await permissions.grant({ ownerId: OWNER_ID, projectId: PROJECT_ID, providerProfile: 'nvidia-hosted-nim', model: 'nvidia/nemotron-3-super-120b-a12b' });
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Use saved provider permission', relativePaths: [], includeRecentMessages: false, idempotencyKey: 'create-grant-auto' });
    const decide = new DecideEgressUseCase(repository, new ProjectFixture(), new ConversationFixture(), workspace, staging, runtime, '/workspace', undefined, permissions);
    const approved = await decide.approveWithRememberedPermission({ ownerId: OWNER_ID, runId: created.resource.id });

    expect(approved).toMatchObject({ status: 'ready', decision: 'approved', providerPermissionId: permission.id });
    await permissions.revoke({ ownerId: OWNER_ID, projectId: PROJECT_ID, permissionId: permission.id });
    const start = new StartAiRunUseCase(repository, new ConversationFixture(), runtime, new InMemoryRunEventPublisher(), undefined, undefined, undefined, permissions);

    await expect(start.execute({ ownerId: OWNER_ID, runId: created.resource.id, idempotencyKey: 'start-after-permission-revoke' })).rejects.toMatchObject({ code: 'PROVIDER_PERMISSION_REVOKED' });
    const reopened = await repository.findByIdForOwner(OWNER_ID, created.resource.id);
    expect(reopened).toMatchObject({ status: 'pending_approval', decision: 'pending' });
    expect(reopened).not.toHaveProperty('providerPermissionId');
    expect(runtime.created).toEqual([created.resource.id]);
  });

  it('carries the same bounded recent-message snapshot into staging after approval', async () => {
    const repository = new InMemoryAiRunRepository();
    const workspace = new WorkspaceFixture();
    const runtime = new RuntimeFixture();
    const staging = new StagingFixture();
    const create = new CreateAiRunUseCase(new ProjectFixture(), new ConversationFixture(), workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b');
    const created = await create.execute({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, request: 'Use bounded conversation context', relativePaths: ['src/index.ts', 'src\\index.ts'], includeRecentMessages: true, idempotencyKey: 'create-run-messages' });
    const decide = new DecideEgressUseCase(repository, new ProjectFixture(), new ConversationFixture(), workspace, staging, runtime, '/workspace');

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
    const decide = new DecideEgressUseCase(repository, new ProjectFixture(), new ConversationFixture(), workspace, staging, runtime, '/workspace');

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
    const decide = new DecideEgressUseCase(repository, new ProjectFixture(), new ConversationFixture(), workspace, staging, runtime, '/workspace');

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
    const decide = new DecideEgressUseCase(repository, new ProjectFixture(), new ConversationFixture(), workspace, staging, runtime, '/workspace', factRecords);

    await expect(decide.execute({ ownerId: OWNER_ID, runId: created.resource.id, manifestHash: created.resource.manifest.manifestHash, decision: 'approve', idempotencyKey: 'decision-stale-fact' }))
      .rejects.toMatchObject({ code: 'EGRESS_SOURCE_CHANGED' });
    const invalidated = await repository.findByIdForOwner(OWNER_ID, created.resource.id);
    expect(invalidated).toMatchObject({ status: 'failed', decision: 'pending', manifestInvalidated: true, providerTransmission: 'not_started_confirmed' });
    expect(runtime.created).toHaveLength(0);
    expect(staging.staged).toHaveLength(0);
  });
});
