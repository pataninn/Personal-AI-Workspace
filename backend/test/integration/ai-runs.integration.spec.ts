import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import { InMemoryAiRunRepository } from '@/infrastructure/ai-runs/in-memory-ai-run-repository';
import { FakeAgentRuntime } from '@/infrastructure/sandbox/fake-agent-runtime';
import { FakeStagingGateway } from '@/infrastructure/staging/fake-staging-gateway';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import type { WorkspaceReadResult, WorkspaceTreeResult } from '@/modules/files/domain/workspace-types';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import type { Conversation, Message, MessagePage } from '@/modules/conversations/domain/conversation-types';
import type { AddMessageRecord, FindConversationInput, IConversationRepository } from '@/modules/conversations/repositories/conversation-repository';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { GetReadinessUseCase } from '@/modules/health';
import { CancelAiRunUseCase, CreateAiRunUseCase, DecideEgressUseCase, GetAiRunUseCase, StartAiRunUseCase } from '@/modules/ai-runs';
import { InMemoryRunEventPublisher } from '@/infrastructure/ai-runs/in-memory-run-event-publisher';
import { createLogger } from '@/shared/logging/logger';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import { ProjectChatContextUseCases } from '@/modules/ai-runs/use-cases/project-chat-context-use-cases';
import { SendChatMessageUseCase } from '@/modules/ai-runs/use-cases/send-chat-message-use-case';
import type { ProjectChatContext } from '@/modules/ai-runs/repositories/project-chat-context-repository';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';

const APP_ORIGIN = 'https://127.0.0.1:8443';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

class ProjectFixture implements IProjectRepository {
  public status: Project['status'] = 'active';
  private readonly project: Project = {
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    name: 'Project',
    slug: 'project',
    relativeRoot: 'project',
    storageKind: 'legacy',
    objective: null,
    status: 'active',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  public async listByOwner(): Promise<readonly Project[]> { return [this.project]; }
  public async findByIdForOwner(): Promise<Project | null> { return { ...this.project, status: this.status }; }
  public async listActiveRoots(): Promise<readonly string[]> { return ['project']; }
  public async create(): Promise<Project> { return this.project; }
  public async updateStatus(): Promise<Project | null> { return this.project; }
}

class ConversationFixture implements IConversationRepository {
  public readonly assistantMessages: Message[] = [];
  public async listByProjectForOwner(): Promise<never> { throw new Error('Not used'); }
  public async findWithMessagesForOwner(_input: FindConversationInput): Promise<MessagePage> {
    const now = new Date();
    const conversation: Conversation = { id: CONVERSATION_ID, ownerId: OWNER_ID, projectId: PROJECT_ID, title: 'Chat', status: 'active', lastActivityAt: now, createdAt: now, updatedAt: now };
    const message: Message = { id: '44444444-4444-4444-8444-444444444444', conversationId: CONVERSATION_ID, role: 'user', sequence: 1, content: 'Previous message', createdAt: now };
    return { conversation, messages: [message], nextBeforeSequence: null };
  }
  public async create(): Promise<never> { throw new Error('Not used'); }
  public async addUserMessage(): Promise<never> { throw new Error('Not used'); }
  public async addAssistantMessage(input: AddMessageRecord): Promise<{ readonly resource: Message; readonly replayed: boolean }> {
    const message: Message = { id: `55555555-5555-4555-8555-${String(this.assistantMessages.length + 1).padStart(12, '0')}`, conversationId: input.conversationId, role: 'assistant', sequence: this.assistantMessages.length + 2, content: input.content, createdAt: new Date() };
    this.assistantMessages.push(message);
    return { resource: message, replayed: false };
  }
}

class WorkspaceFixture implements IWorkspaceGateway {
  public changed = false;

  public async list(): Promise<never> { throw new Error('Not used'); }
  public async tree(): Promise<WorkspaceTreeResult> { return { directory: '', depth: 6, entries: [], truncated: false }; }
  public async searchText(): Promise<never> { throw new Error('Not used'); }
  public async readText(_scope: unknown, input: { readonly path: string }): Promise<WorkspaceReadResult> {
    const content = this.changed ? 'changed content\n' : 'safe content\n';
    return { path: input.path, content, encoding: 'utf-8', sizeBytes: Buffer.byteLength(content), lineCount: 1, truncated: false };
  }
}

function buildApp(): { readonly app: express.Express; readonly staging: FakeStagingGateway; readonly runtime: FakeAgentRuntime; readonly workspace: WorkspaceFixture; readonly repository: InMemoryAiRunRepository; readonly conversations: ConversationFixture; readonly projects: ProjectFixture } {
  const projects = new ProjectFixture();
  const conversations = new ConversationFixture();
  const workspace = new WorkspaceFixture();
  const repository = new InMemoryAiRunRepository();
  const staging = new FakeStagingGateway();
  const runtime = new FakeAgentRuntime();
  const runEvents = new InMemoryRunEventPublisher();
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  const getSession = { execute: jest.fn(async (token: string | undefined) => {
    if (!token) throw new UnauthenticatedError();
    return { sessionId: 'session', principal: { id: OWNER_ID, displayName: 'Local user' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000) };
  }) } as unknown as GetSessionUseCase;
  let chatContext: ProjectChatContext = { relativePaths: [], factIds: [], includeProjectConversations: true };
  const contexts = { get: jest.fn(async () => chatContext), update: jest.fn(async (_owner: string, _project: string, changes: Partial<ProjectChatContext>) => { chatContext = { ...chatContext, ...changes }; return chatContext; }) };
  const facts: IProjectFactRepository = { findActiveByIds: jest.fn().mockResolvedValue([]), listActiveByProject: jest.fn(), findActiveById: jest.fn(), create: jest.fn(), update: jest.fn(), verify: jest.fn(), softDelete: jest.fn() };
  const createRun = new CreateAiRunUseCase(projects, conversations, workspace, repository, 'nvidia-hosted-nim', 'test-model', facts);
  const decide = new DecideEgressUseCase(repository, projects, conversations, workspace, staging, runtime, '/workspace', facts);
  const start = new StartAiRunUseCase(repository, conversations, runtime, runEvents, undefined, projects);
  const app = createApp({
    logger: createLogger('silent'),
    readiness: new GetReadinessUseCase(readiness),
    appVersion: 'test',
    aiRuns: {
      projectChatContext: new ProjectChatContextUseCases(projects, contexts, facts, workspace),
      sendChatMessage: new SendChatMessageUseCase(contexts, facts, createRun, decide),
      getSession,
      createAiRun: new CreateAiRunUseCase(projects, conversations, workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b'),
      getAiRun: new GetAiRunUseCase(repository, projects),
      decideEgress: new DecideEgressUseCase(repository, projects, conversations, workspace, staging, runtime, '/workspace'),
      appOrigin: APP_ORIGIN,
      clearSessionCookie: () => undefined
    },
    aiRunChat: {
      getSession,
      getAiRun: new GetAiRunUseCase(repository, projects),
      startAiRun: new StartAiRunUseCase(repository, conversations, runtime, runEvents, undefined, projects),
      cancelAiRun: new CancelAiRunUseCase(repository, runtime, runEvents, projects),
      events: runEvents,
      principalAuthorization: {
        isActive: async () => true,
        assertActive: async () => undefined,
        withActivePrincipal: async <T>(_principalId: string, action: (assertStillActive: () => Promise<void>) => Promise<T>): Promise<T> => action(async () => undefined)
      },
      appOrigin: APP_ORIGIN,
      clearSessionCookie: () => undefined
    }
  });
  return { app, staging, runtime, workspace, repository, conversations, projects };
}

describe('AI runs API (integration)', () => {
  it('persists project context and requires explicit consent and start before provider startup', async () => {
    const context = buildApp();
    const headers = { Origin: APP_ORIGIN, Cookie: '__Host-pa_session=test', 'X-CSRF-Token': 'csrf-token' };
    const contextPath = `/api/v1/projects/${PROJECT_ID}/chat-context`;
    await request(context.app).get(contextPath).set(headers).expect(200).expect(({ body }) => expect(body.data.includeProjectConversations).toBe(true));
    await request(context.app).patch(contextPath).set(headers).send({ relativePaths: ['README.md'] }).expect(200);
    await request(context.app).get(contextPath).set(headers).expect(200).expect(({ body }) => expect(body.data).toMatchObject({ relativePaths: ['README.md'], factIds: [], includeProjectConversations: true, availablePaths: ['README.md'], excludedPaths: [], fileSelectionLimited: false }));
    const sent = await request(context.app).post(`/api/v1/projects/${PROJECT_ID}/chat-runs`).set(headers).set('Idempotency-Key', 'direct-chat-test')
      .send({ conversationId: CONVERSATION_ID, request: 'Continue the earlier chat' }).expect(202);
    expect(sent.body.data.run).toMatchObject({ decision: 'pending', status: 'pending_approval', conversationId: CONVERSATION_ID });
    expect(sent.body.data.manifest.status).toBe('pending_approval');
    expect(sent.body.data.manifest.content.relativePaths).toEqual(['README.md']);
    expect(sent.body.data.manifest.content.messageCount).toBe(1);
    expect(context.staging.staged).toHaveLength(0);
    expect(context.runtime.createdRuns).toHaveLength(0);
    expect(context.runtime.startedRuns).toHaveLength(0);
    const replay = await request(context.app).post(`/api/v1/projects/${PROJECT_ID}/chat-runs`).set(headers).set('Idempotency-Key', 'direct-chat-test')
      .send({ conversationId: CONVERSATION_ID, request: 'Continue the earlier chat' }).expect(200);
    expect(replay.body.data.run.runId).toBe(sent.body.data.run.runId);

    const runId = sent.body.data.run.runId as string;
    const approved = await request(context.app).post(`/api/v1/ai-runs/${runId}/egress-decision`).set(headers).set('Idempotency-Key', 'direct-chat-decision')
      .send({ manifestHash: sent.body.data.manifest.manifestHash, decision: 'approve' }).expect(200);
    expect(approved.body.data.run.status).toBe('ready');
    expect(context.staging.staged).toHaveLength(1);
    expect(context.runtime.createdRuns).toHaveLength(1);
    expect(context.runtime.startedRuns).toHaveLength(0);

    await request(context.app).post(`/api/v1/ai-runs/${runId}/start`).set(headers).set('Idempotency-Key', 'direct-chat-start').send({}).expect(202);
    for (let attempt = 0; attempt < 100 && context.runtime.startedRuns.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    expect(context.runtime.startedRuns).toHaveLength(1);
  });

  it('protects direct send and context mutations with the normal session, origin, and CSRF checks', async () => {
    const { app } = buildApp();
    await request(app).get(`/api/v1/projects/${PROJECT_ID}/chat-context`).expect(401);
    await request(app).patch(`/api/v1/projects/${PROJECT_ID}/chat-context`).set('Cookie', '__Host-pa_session=test')
      .set('Origin', 'https://other.example').send({ relativePaths: [] }).expect(403);
    await request(app).post(`/api/v1/projects/${PROJECT_ID}/chat-runs`).set('Origin', APP_ORIGIN).set('Cookie', '__Host-pa_session=test')
      .send({ conversationId: CONVERSATION_ID, request: 'Hello' }).expect(403);
  });
  it('creates a disclosure, keeps calls local before consent, and rejects without staging', async () => {
    const context = buildApp();
    const headers = { Origin: APP_ORIGIN, Cookie: '__Host-pa_session=test', 'X-CSRF-Token': 'csrf-token' };
    const created = await request(context.app)
      .post(`/api/v1/projects/${PROJECT_ID}/ai-runs`)
      .set(headers)
      .set('Idempotency-Key', 'run-intent-1')
      .send({ conversationId: CONVERSATION_ID, request: 'Inspect this project', context: { relativePaths: ['README.md'] } })
      .expect(202);

    expect(created.body.data.manifest.preConsentNotice).toContain('Nothing has been copied');
    expect(created.body.data.manifest.content.relativePaths).toEqual(['README.md']);
    expect(context.staging.staged).toHaveLength(0);
    expect(context.runtime.createdRuns).toHaveLength(0);

    const runId = created.body.data.run.runId as string;
    const manifestHash = created.body.data.manifest.manifestHash as string;
    await request(context.app)
      .post(`/api/v1/ai-runs/${runId}/egress-decision`)
      .set(headers)
      .set('Idempotency-Key', 'run-decision-1')
      .send({ manifestHash, decision: 'reject' })
      .expect(200)
      .expect(({ body }) => expect(body.data.run.status).toBe('rejected'));
    expect(context.staging.staged).toHaveLength(0);
    expect(context.runtime.createdRuns).toHaveLength(0);
  });

  it('persists the exact approval before fake staging/runtime readiness', async () => {
    const context = buildApp();
    const headers = { Origin: APP_ORIGIN, Cookie: '__Host-pa_session=test', 'X-CSRF-Token': 'csrf-token' };
    const created = await request(context.app)
      .post(`/api/v1/projects/${PROJECT_ID}/ai-runs`)
      .set(headers)
      .set('Idempotency-Key', 'run-intent-2')
      .send({ conversationId: CONVERSATION_ID, request: 'Prepare the private run', context: { relativePaths: ['README.md'] } })
      .expect(202);
    const runId = created.body.data.run.runId as string;
    const manifestHash = created.body.data.manifest.manifestHash as string;

    const approved = await request(context.app)
      .post(`/api/v1/ai-runs/${runId}/egress-decision`)
      .set(headers)
      .set('Idempotency-Key', 'run-decision-2')
      .send({ manifestHash, decision: 'approve' })
      .expect(200);

    expect(approved.body.data.run.status).toBe('ready');
    expect(context.staging.staged).toHaveLength(1);
    expect(context.runtime.createdRuns).toHaveLength(1);
    expect(JSON.stringify(approved.body)).not.toContain('safe content');
  });

  it('keeps CSRF/origin and create idempotency boundaries on the run endpoints', async () => {
    const context = buildApp();
    const headers = { Origin: APP_ORIGIN, Cookie: '__Host-pa_session=test', 'X-CSRF-Token': 'csrf-token' };
    const payload = { conversationId: CONVERSATION_ID, request: 'Idempotent request', context: { relativePaths: ['README.md'] } };

    await request(context.app)
      .post(`/api/v1/projects/${PROJECT_ID}/ai-runs`)
      .set({ ...headers, Origin: 'https://evil.invalid' })
      .set('Idempotency-Key', 'run-intent-csrf')
      .send(payload)
      .expect(403);
    expect(context.staging.staged).toHaveLength(0);

    const first = await request(context.app)
      .post(`/api/v1/projects/${PROJECT_ID}/ai-runs`)
      .set(headers)
      .set('Idempotency-Key', 'run-intent-idempotent')
      .send(payload)
      .expect(202);
    expect(first.body.data.run.status).toBe('pending_approval');

    await request(context.app)
      .post(`/api/v1/projects/${PROJECT_ID}/ai-runs`)
      .set(headers)
      .set('Idempotency-Key', 'run-intent-idempotent')
      .send({ ...payload, request: 'Different request' })
      .expect(409);

    await request(context.app)
      .post(`/api/v1/ai-runs/${first.body.data.run.runId}/egress-decision`)
      .set({ ...headers, 'X-CSRF-Token': 'wrong-token' })
      .set('Idempotency-Key', 'run-decision-csrf')
      .send({ manifestHash: first.body.data.manifest.manifestHash, decision: 'reject' })
      .expect(403);
    expect(context.staging.staged).toHaveLength(0);
  });

  it('invalidates a drifted approval and blocks stale manifest refresh', async () => {
    const context = buildApp();
    const headers = { Origin: APP_ORIGIN, Cookie: '__Host-pa_session=test', 'X-CSRF-Token': 'csrf-token' };
    const created = await request(context.app)
      .post(`/api/v1/projects/${PROJECT_ID}/ai-runs`)
      .set(headers)
      .set('Idempotency-Key', 'run-intent-drift')
      .send({ conversationId: CONVERSATION_ID, request: 'Check drift', context: { relativePaths: ['README.md'] } })
      .expect(202);
    context.workspace.changed = true;
    const runId = created.body.data.run.runId as string;
    const manifestHash = created.body.data.manifest.manifestHash as string;

    await request(context.app)
      .post(`/api/v1/ai-runs/${runId}/egress-decision`)
      .set(headers)
      .set('Idempotency-Key', 'run-decision-drift')
      .send({ manifestHash, decision: 'approve' })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('EGRESS_SOURCE_CHANGED'));
    await request(context.app)
      .get(`/api/v1/ai-runs/${runId}/egress-manifest`)
      .set(headers)
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('EGRESS_MANIFEST_CONFLICT'));
    expect(context.staging.staged).toHaveLength(0);
    expect(context.runtime.createdRuns).toHaveLength(0);
  });

  it('starts an approved fake run idempotently and returns a best-effort terminal SSE stream', async () => {
    const context = buildApp();
    const headers = { Origin: APP_ORIGIN, Cookie: '__Host-pa_session=test', 'X-CSRF-Token': 'csrf-token' };
    const created = await request(context.app)
      .post(`/api/v1/projects/${PROJECT_ID}/ai-runs`)
      .set(headers)
      .set('Idempotency-Key', 'run-intent-chat')
      .send({ conversationId: CONVERSATION_ID, request: 'Answer from the private run', context: { relativePaths: [] } })
      .expect(202);
    const runId = created.body.data.run.runId as string;
    await request(context.app)
      .post(`/api/v1/ai-runs/${runId}/egress-decision`)
      .set(headers)
      .set('Idempotency-Key', 'run-decision-chat')
      .send({ manifestHash: created.body.data.manifest.manifestHash, decision: 'approve' })
      .expect(200);

    await request(context.app)
      .post(`/api/v1/ai-runs/${runId}/start`)
      .set(headers)
      .set('Idempotency-Key', 'run-start-chat')
      .send({})
      .expect(202)
      .expect(({ body }) => expect(['queued', 'running', 'succeeded']).toContain(body.data.run.status));
    await request(context.app)
      .post(`/api/v1/ai-runs/${runId}/start`)
      .set(headers)
      .set('Idempotency-Key', 'run-start-chat')
      .send({})
      .expect((response) => expect([200, 202]).toContain(response.status));

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await context.repository.findByIdForOwner(OWNER_ID, runId);
      if (run?.status === 'succeeded') {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    expect((await context.repository.findByIdForOwner(OWNER_ID, runId))?.status).toBe('succeeded');
    expect(context.conversations.assistantMessages).toHaveLength(1);

    const stream = await request(context.app)
      .get(`/api/v1/ai-runs/${runId}/events`)
      .set({ Cookie: '__Host-pa_session=test' })
      .expect(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.text).toContain('event: run.snapshot');
  });

  it('rejects archived-project start and cancel before mutating the run or calling the runtime', async () => {
    const context = buildApp();
    const headers = { Origin: APP_ORIGIN, Cookie: '__Host-pa_session=test', 'X-CSRF-Token': 'csrf-token' };
    const created = await request(context.app)
      .post(`/api/v1/projects/${PROJECT_ID}/ai-runs`)
      .set(headers)
      .set('Idempotency-Key', 'run-intent-archived')
      .send({ conversationId: CONVERSATION_ID, request: 'Archived project request', context: { relativePaths: [] } })
      .expect(202);
    const runId = created.body.data.run.runId as string;
    await request(context.app)
      .post(`/api/v1/ai-runs/${runId}/egress-decision`)
      .set(headers)
      .set('Idempotency-Key', 'run-decision-archived')
      .send({ manifestHash: created.body.data.manifest.manifestHash, decision: 'approve' })
      .expect(200);

    context.projects.status = 'archived';
    await request(context.app)
      .post(`/api/v1/ai-runs/${runId}/start`)
      .set(headers)
      .set('Idempotency-Key', 'run-start-archived')
      .send({})
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('PROJECT_ARCHIVED'));
    await request(context.app)
      .post(`/api/v1/ai-runs/${runId}/cancel`)
      .set(headers)
      .set('Idempotency-Key', 'run-cancel-archived')
      .send({})
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('PROJECT_ARCHIVED'));

    expect((await context.repository.findByIdForOwner(OWNER_ID, runId))?.status).toBe('ready');
    expect(context.runtime.startedRuns).toHaveLength(0);
    expect(context.runtime.cancelledRuns).toHaveLength(0);
  });
});
