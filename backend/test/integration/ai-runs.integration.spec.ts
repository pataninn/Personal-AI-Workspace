import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import { InMemoryAiRunRepository } from '@/infrastructure/ai-runs/in-memory-ai-run-repository';
import { FakeAgentRuntime } from '@/infrastructure/sandbox/fake-agent-runtime';
import { FakeStagingGateway } from '@/infrastructure/staging/fake-staging-gateway';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import type { WorkspaceReadResult } from '@/modules/files/domain/workspace-types';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import type { Conversation, Message, MessagePage } from '@/modules/conversations/domain/conversation-types';
import type { FindConversationInput, IConversationRepository } from '@/modules/conversations/repositories/conversation-repository';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { GetReadinessUseCase } from '@/modules/health';
import { CreateAiRunUseCase, DecideEgressUseCase, GetAiRunUseCase } from '@/modules/ai-runs';
import { createLogger } from '@/shared/logging/logger';

const APP_ORIGIN = 'https://127.0.0.1:8443';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

class ProjectFixture implements IProjectRepository {
  private readonly project: Project = {
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    name: 'Project',
    slug: 'project',
    relativeRoot: '',
    status: 'active',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  public async listByOwner(): Promise<readonly Project[]> { return [this.project]; }
  public async findByIdForOwner(): Promise<Project | null> { return this.project; }
  public async listActiveRoots(): Promise<readonly string[]> { return ['']; }
  public async create(): Promise<Project> { return this.project; }
  public async updateStatus(): Promise<Project | null> { return this.project; }
}

class ConversationFixture implements IConversationRepository {
  public async listByProjectForOwner(): Promise<never> { throw new Error('Not used'); }
  public async findWithMessagesForOwner(_input: FindConversationInput): Promise<MessagePage> {
    const now = new Date();
    const conversation: Conversation = { id: CONVERSATION_ID, ownerId: OWNER_ID, projectId: PROJECT_ID, title: 'Chat', status: 'active', lastActivityAt: now, createdAt: now, updatedAt: now };
    const message: Message = { id: '44444444-4444-4444-8444-444444444444', conversationId: CONVERSATION_ID, role: 'user', sequence: 1, content: 'Previous message', createdAt: now };
    return { conversation, messages: [message], nextBeforeSequence: null };
  }
  public async create(): Promise<never> { throw new Error('Not used'); }
  public async addUserMessage(): Promise<never> { throw new Error('Not used'); }
}

class WorkspaceFixture implements IWorkspaceGateway {
  public changed = false;

  public async list(): Promise<never> { throw new Error('Not used'); }
  public async tree(): Promise<never> { throw new Error('Not used'); }
  public async searchText(): Promise<never> { throw new Error('Not used'); }
  public async readText(_scope: unknown, input: { readonly path: string }): Promise<WorkspaceReadResult> {
    const content = this.changed ? 'changed content\n' : 'safe content\n';
    return { path: input.path, content, encoding: 'utf-8', sizeBytes: Buffer.byteLength(content), lineCount: 1, truncated: false };
  }
}

function buildApp(): { readonly app: express.Express; readonly staging: FakeStagingGateway; readonly runtime: FakeAgentRuntime; readonly workspace: WorkspaceFixture } {
  const projects = new ProjectFixture();
  const conversations = new ConversationFixture();
  const workspace = new WorkspaceFixture();
  const repository = new InMemoryAiRunRepository();
  const staging = new FakeStagingGateway();
  const runtime = new FakeAgentRuntime();
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  const getSession = { execute: jest.fn().mockResolvedValue({ sessionId: 'session', principal: { id: OWNER_ID, displayName: 'Local user' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000) }) } as unknown as GetSessionUseCase;
  const app = createApp({
    logger: createLogger('silent'),
    readiness: new GetReadinessUseCase(readiness),
    appVersion: 'test',
    aiRuns: {
      getSession,
      createAiRun: new CreateAiRunUseCase(projects, conversations, workspace, repository, 'nvidia-hosted-nim', 'nvidia/nemotron-3-super-120b-a12b'),
      getAiRun: new GetAiRunUseCase(repository),
      decideEgress: new DecideEgressUseCase(repository, conversations, workspace, staging, runtime, '/workspace'),
      appOrigin: APP_ORIGIN,
      clearSessionCookie: () => undefined
    }
  });
  return { app, staging, runtime, workspace };
}

describe('AI runs API (integration)', () => {
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
});
