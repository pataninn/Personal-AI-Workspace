import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import { InMemoryAiRunRepository } from '@/infrastructure/ai-runs/in-memory-ai-run-repository';
import { InMemoryProposedChangeSetRepository } from '@/infrastructure/ai-runs/in-memory-change-set-repository';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { createLogger } from '@/shared/logging/logger';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import type { IConversationRepository } from '@/modules/conversations/repositories/conversation-repository';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { AiRun, EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { CreateAiRunUseCase, DecideEgressUseCase, GetAiRunUseCase } from '@/modules/ai-runs/use-cases/ai-run-use-cases';
import { GetReadinessUseCase } from '@/modules/health';
import { CollectProposedChangeSetUseCase, DecideProposedChangeSetUseCase, GetProposedChangeSetUseCase } from '@/modules/ai-runs/use-cases/change-set-use-cases';
import type { IWorkspaceMutationGateway, WorkspaceApplyResult, WorkspaceMutationApplyOptions, WorkspaceMutationScope, WorkspaceFileSnapshot } from '@/modules/ai-runs/repositories/workspace-mutation-gateway';
import type { CreateProposedChangeSetRecord } from '@/modules/ai-runs/domain/change-types';
import type { AssertAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';

const APP_ORIGIN = 'https://127.0.0.1:8443';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '99999999-9999-4999-8999-999999999999';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE = 'src/app.ts';
const SOURCE_HASH = 'a'.repeat(64);

describe('Task 4.1 proposed change-set Express boundary (integration)', () => {
  it('authenticates review, returns counts/hashes without raw proposed content, and enforces owner scope', async () => {
    const context = await buildContext();
    const headers = authHeaders();

    const response = await request(context.app).get(`/api/v1/ai-runs/${context.runId}/proposed-change-set`).set(headers).expect(200);
    expect(response.body.data.counts).toMatchObject({ total: 1, edits: 1, destructive: 1 });
    expect(response.body.data.operations[0]).toMatchObject({ path: SOURCE, expectedSourceHash: SOURCE_HASH });
    expect(JSON.stringify(response.body)).not.toContain('super-secret-proposed-content');
    expect(response.body.data).not.toHaveProperty('backupCheckpoints');

    const crossOwner = await request(context.app).get(`/api/v1/ai-runs/${context.runId}/proposed-change-set`).set({ Cookie: '__Host-pa_session=other' }).expect(404);
    expect(crossOwner.body.error.code).toBe('CHANGE_SET_NOT_FOUND');
  });

  it('requires origin and CSRF, then retires every legacy decision without changing proposal state', async () => {
    const context = await buildContext();
    const headers = authHeaders();
    await request(context.app).post(`/api/v1/ai-runs/${context.runId}/proposed-change-set/decision`).set({ ...headers, Origin: 'https://evil.invalid' }).set('Idempotency-Key', 'reject-1').send({ proposalHash: context.proposalHash, decision: 'reject' }).expect(403);
    await request(context.app).post(`/api/v1/ai-runs/${context.runId}/proposed-change-set/decision`).set({ ...headers, 'X-CSRF-Token': 'wrong' }).set('Idempotency-Key', 'reject-1').send({ proposalHash: context.proposalHash, decision: 'reject' }).expect(403);

    for (const [decision, key] of [['approve', 'approve-1'], ['reject', 'reject-1'], ['deny', 'deny-1']] as const) {
      await request(context.app).post(`/api/v1/ai-runs/${context.runId}/proposed-change-set/decision`).set(headers).set('Idempotency-Key', key)
        .send({ proposalHash: context.proposalHash, decision }).expect(409)
        .expect(({ body }) => expect(body.error.code).toBe('POLICY_ACTION_RETIRED'));
    }
    expect(await context.changeSets.findByRunForOwner(OWNER_ID, context.runId)).toMatchObject({ status: 'awaiting_approval', decision: 'pending' });
    expect(context.gateway.applyCalls).toBe(0);
    expect(context.gateway.events).toEqual([]);
  });

  it('applies a supported change through the policy path without recording an approval', async () => {
    const context = await buildContext({ policyAuthorized: true });
    const recordDecision = jest.spyOn(context.changeSets, 'recordDecision');
    const applied = await context.decideChangeSet.executeAutomatically({ ownerId: OWNER_ID, runId: context.runId });
    expect(applied).toMatchObject({ status: 'applied', decision: 'policy_authorized' });
    expect(context.gateway.events).toEqual(['decision-visible', 'apply']);
    expect(context.gateway.applyCalls).toBe(1);
    expect(recordDecision).not.toHaveBeenCalled();
    await expect(context.changeSets.findByRunForOwner(OWNER_ID, context.runId)).resolves.toMatchObject({ status: 'applied', decision: 'policy_authorized' });
  });

  it('blocks archived automatic work and keeps even malformed legacy decision calls side-effect free', async () => {
    const context = await buildContext({ policyAuthorized: true });
    context.projects.status = 'archived';
    const headers = authHeaders();
    await expect(context.decideChangeSet.executeAutomatically({ ownerId: OWNER_ID, runId: context.runId })).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
    await request(context.app).post(`/api/v1/ai-runs/${context.runId}/proposed-change-set/decision`).set(headers).set('Idempotency-Key', 'archived').send({ proposalHash: context.proposalHash, decision: 'approve' }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('POLICY_ACTION_RETIRED'));
    expect(context.gateway.applyCalls).toBe(0);
    await request(context.app).post(`/api/v1/ai-runs/${context.runId}/proposed-change-set/decision`).set(headers).set('Idempotency-Key', 'bad-body').send({ proposalHash: 'bad', decision: 'maybe' }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('POLICY_ACTION_RETIRED'));
    expect(await context.changeSets.findByRunForOwner(OWNER_ID, context.runId)).toMatchObject({ status: 'awaiting_approval', decision: 'pending' });
    expect(context.gateway.applyCalls).toBe(0);
  });
});

interface TestContext {
  readonly app: express.Express;
  readonly runId: string;
  readonly proposalHash: string;
  readonly changeSets: InMemoryProposedChangeSetRepository;
  readonly gateway: MutationFixture;
  readonly projects: ProjectFixture;
  readonly decideChangeSet: DecideProposedChangeSetUseCase;
}

async function buildContext(options: { readonly outcome?: WorkspaceApplyResult['outcome']; readonly policyAuthorized?: boolean } = {}): Promise<TestContext> {
  const projects = new ProjectFixture();
  const runs = new InMemoryAiRunRepository();
  const run = await createSucceededRun(runs);
  if (options.policyAuthorized) {
    await runs.save({ ...run, status: 'running', phase: 'runtime', decision: 'policy_authorized', policyRevision: '1', safeMessage: 'Processing under workspace policy.' });
  }
  const changeSets = new InMemoryProposedChangeSetRepository();
  const gateway = new MutationFixture(runs, changeSets, run.id, options.outcome ?? 'applied');
  const collector = new CollectProposedChangeSetUseCase(runs, projects, gateway, changeSets);
    const collected = await collector.execute({ ownerId: OWNER_ID, runId: run.id, changes: [{ operation: 'edit', path: SOURCE, content: 'const replacement = "bounded-proposed-content";', summary: 'Replace the implementation' }], fakeRuntime: true });
  const getChangeSet = new GetProposedChangeSetUseCase(runs, projects, changeSets);
  const executionPolicy = { assertWorkspace: jest.fn(async () => ({ policies: [], effectiveCapabilities: ['workspace_file_write'], revisions: { workspace: '1' } })) } as unknown as Pick<AssertAssistantExecutionPolicyUseCase, 'assertWorkspace'>;
  const decideChangeSet = new DecideProposedChangeSetUseCase(runs, projects, changeSets, gateway, undefined, undefined, executionPolicy);
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  const getSession = { execute: jest.fn().mockImplementation((cookie?: string) => Promise.resolve({ sessionId: 'session', principal: { id: cookie === 'other' ? OTHER_OWNER_ID : OWNER_ID, displayName: 'Local user', accountKind: 'regular', role: 'admin' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000) })) } as unknown as GetSessionUseCase;
  const app = createApp({
    logger: createLogger('silent'),
    readiness: new GetReadinessUseCase(readiness),
    appVersion: 'test',
    aiRuns: {
      getSession,
      createAiRun: {} as CreateAiRunUseCase,
      getAiRun: {} as GetAiRunUseCase,
      decideEgress: {} as DecideEgressUseCase,
      getProposedChangeSet: getChangeSet,
      decideProposedChangeSet: decideChangeSet,
      appOrigin: APP_ORIGIN,
      clearSessionCookie: () => undefined
    }
  });
  return { app, runId: run.id, proposalHash: collected.proposalHash, changeSets, gateway, projects, decideChangeSet };
}

async function createSucceededRun(repository: InMemoryAiRunRepository): Promise<AiRun> {
  const manifest: EgressManifest = {
    manifestHash: 'b'.repeat(64),
    provider: 'NVIDIA hosted NIM',
    providerProfile: 'nvidia-hosted-nim',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    categories: ['Request'],
    files: [{ relativePath: SOURCE, sourceHash: SOURCE_HASH, sizeBytes: 12 }],
    requestBytes: 4,
    messageBytes: 0,
    messageCount: 0,
    messageHash: 'c'.repeat(64),
    byteEstimate: 4,
    tokenEstimate: 1,
    excludedItemCount: 0,
    omittedItemCount: 0,
    omissionSummary: 'No selected items were excluded or omitted.',
    bestEffortSecretDetection: true
  };
  const created = await repository.create({ ownerId: OWNER_ID, projectId: PROJECT_ID, conversationId: '44444444-4444-4444-8444-444444444444', request: 'edit the file', relativeRoot: 'project', storageKind: 'legacy', requestedPaths: [SOURCE], manifest, idempotencyKey: 'run', requestFingerprint: 'fingerprint' });
  const run: AiRun = { ...created.resource, status: 'succeeded', phase: 'terminal', decision: 'approved', runtimeKind: 'fake', sandboxReady: true, safeMessage: 'Complete', updatedAt: new Date() };
  await repository.save(run);
  return run;
}

class ProjectFixture implements IProjectRepository {
  public status: Project['status'] = 'active';
  private readonly project: Project = { id: PROJECT_ID, ownerId: OWNER_ID, name: 'Project', slug: 'project', relativeRoot: 'project', storageKind: 'legacy', objective: null, status: 'active', version: 1, createdAt: new Date(), updatedAt: new Date() };
  public async listByOwner(): Promise<readonly Project[]> { return [{ ...this.project, status: this.status }]; }
  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> { return ownerId === OWNER_ID && projectId === PROJECT_ID ? { ...this.project, status: this.status } : null; }
  public async listActiveRoots(): Promise<readonly string[]> { return ['project']; }
  public async create(): Promise<Project> { return this.project; }
  public async updateStatus(): Promise<Project | null> { return this.project; }
}

class MutationFixture implements IWorkspaceMutationGateway {
  public applyCalls = 0;
  public readonly events: string[] = [];
  public constructor(private readonly runs: InMemoryAiRunRepository, private readonly changeSets: InMemoryProposedChangeSetRepository, private readonly runId: string, private readonly outcome: WorkspaceApplyResult['outcome']) {}
  public async inspect(_scope: WorkspaceMutationScope, relativePath: string): Promise<WorkspaceFileSnapshot> { return relativePath === SOURCE ? { path: SOURCE, exists: true, isDirectory: false, sizeBytes: 12, content: 'safe source\n', hash: SOURCE_HASH } : { path: relativePath, exists: false, isDirectory: false, sizeBytes: 0 }; }
  public async applyChangeSet(_scope: WorkspaceMutationScope, operations: readonly { readonly operationId: string; readonly operation: 'create' | 'edit' | 'overwrite' | 'rename' | 'delete'; readonly path: string }[], _runId: string, _proposalHash: string, options?: WorkspaceMutationApplyOptions): Promise<WorkspaceApplyResult> {
    this.applyCalls += 1;
    const current = await this.changeSets.findByRunForOwner(OWNER_ID, this.runId);
    if (current?.status === 'applying') this.events.push('decision-visible');
    this.events.push('apply');
    const operation = operations[0];
    if (this.outcome === 'needs_manual_review') return { outcome: 'needs_manual_review', operations: [{ operationId: operation?.operationId ?? 'operation', operation: operation?.operation ?? 'edit', path: operation?.path ?? SOURCE, status: 'needs_manual_review', backup: 'unknown', safeMessage: 'unknown' }] };
    if (this.outcome === 'stale') return { outcome: 'stale', conflict: { path: SOURCE, reason: 'changed' }, operations: [{ operationId: operation?.operationId ?? 'operation', operation: operation?.operation ?? 'edit', path: operation?.path ?? SOURCE, status: 'skipped', backup: 'not_required', safeMessage: 'stale' }] };
    if (this.outcome === 'failed') return { outcome: 'failed', operations: [{ operationId: operation?.operationId ?? 'operation', operation: operation?.operation ?? 'edit', path: operation?.path ?? SOURCE, status: 'failed', backup: 'created', safeMessage: 'known failure' }] };
    await options?.recordBackupCheckpoint?.({ reference: 'private/recovery/checkpoint', operationId: operation?.operationId ?? 'operation', path: SOURCE, sizeBytes: 12, contentSha256: SOURCE_HASH, createdAt: new Date() });
    return { outcome: 'applied', operations: [{ operationId: operation?.operationId ?? 'operation', operation: operation?.operation ?? 'edit', path: operation?.path ?? SOURCE, status: 'applied', backup: 'created', backupReference: 'private/recovery/checkpoint', safeMessage: 'applied' }] };
  }
}

function authHeaders(): Record<string, string> {
  return { Origin: APP_ORIGIN, Cookie: '__Host-pa_session=test', 'X-CSRF-Token': 'csrf-token' };
}
