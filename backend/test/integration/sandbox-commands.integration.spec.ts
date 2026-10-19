import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import { InMemorySandboxCommandRepository } from '@/infrastructure/ai-runs/in-memory-sandbox-command-repository';
import { FakeAgentRuntime } from '@/infrastructure/sandbox/fake-agent-runtime';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import type { AiRun } from '@/modules/ai-runs/domain/ai-run-types';
import { CancelSandboxCommandUseCase, DecideSandboxCommandUseCase, GetSandboxCommandUseCase, ListSandboxCommandsUseCase, ProposeSandboxCommandUseCase } from '@/modules/ai-runs';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { Project } from '@/modules/projects/domain/project-types';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import { GetReadinessUseCase } from '@/modules/health';
import { createLogger } from '@/shared/logging/logger';

const APP_ORIGIN = 'https://127.0.0.1:8443';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '99999999-9999-4999-8999-999999999999';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT_ID = '88888888-8888-4888-8888-888888888888';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_RUN_ID = '77777777-7777-4777-8777-777777777777';

class ProjectFixture implements IProjectRepository {
  public status: Project['status'] = 'active';
  private readonly projects = new Map<string, Project>([
    [PROJECT_ID, this.makeProject(PROJECT_ID, OWNER_ID)],
    [OTHER_PROJECT_ID, this.makeProject(OTHER_PROJECT_ID, OTHER_OWNER_ID)]
  ]);

  public async listByOwner(ownerId: string, includeArchived: boolean): Promise<readonly Project[]> {
    return [...this.projects.values()].filter((project) => project.ownerId === ownerId && (includeArchived || project.status === 'active'));
  }

  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> {
    const project = this.projects.get(projectId);
    if (!project) {
      return null;
    }
    if (project.id === PROJECT_ID) {
      return { ...project, status: this.status };
    }
    return project.ownerId === ownerId ? project : null;
  }

  public async listActiveRoots(ownerId: string): Promise<readonly string[]> {
    return (await this.listByOwner(ownerId, false)).flatMap((project) => project.relativeRoot === null ? [] : [project.relativeRoot]);
  }

  public async create(): Promise<Project> { throw new Error('Not used by command routes.'); }
  public async updateStatus(): Promise<Project | null> { throw new Error('Not used by command routes.'); }

  private makeProject(id: string, ownerId: string): Project {
    const now = new Date('2026-09-16T00:00:00.000Z');
    return { id, ownerId, name: 'Project', slug: 'project', relativeRoot: id === PROJECT_ID ? 'project' : 'other', storageKind: 'legacy', objective: null, status: 'active', version: 1, createdAt: now, updatedAt: now };
  }
}

class ReadyRunFixture implements IAiRunRepository {
  private readonly runs = new Map<string, AiRun>([
    [RUN_ID, this.makeRun(RUN_ID, OWNER_ID, PROJECT_ID)],
    [OTHER_RUN_ID, this.makeRun(OTHER_RUN_ID, OTHER_OWNER_ID, OTHER_PROJECT_ID)]
  ]);

  public async create(): Promise<never> { throw new Error('Not used by command routes.'); }
  public async findByIdForOwner(ownerId: string, runId: string): Promise<AiRun | null> {
    const run = this.runs.get(runId);
    return run?.ownerId === ownerId ? run : null;
  }
  public async recordDecision(): Promise<never> { throw new Error('Not used by command routes.'); }
  public async save(): Promise<void> { return undefined; }
  public async beginStart(): Promise<{ readonly resource: AiRun; readonly replayed: boolean }> { throw new Error('Not used by command routes.'); }
  public async abortStart(): Promise<boolean> { return false; }

  private makeRun(id: string, ownerId: string, projectId: string): AiRun {
    const now = new Date('2026-09-16T00:00:00.000Z');
    return {
      id,
      ownerId,
      projectId,
      conversationId: '44444444-4444-4444-8444-444444444444',
      request: 'inspect',
      relativeRoot: '',
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
      createdAt: now,
      updatedAt: now
    };
  }
}

class PausingRuntime extends FakeAgentRuntime {
  public readonly executeStarted: Promise<void>;
  private resolveExecuteStarted!: () => void;
  private releaseExecution!: () => void;

  public constructor() {
    super();
    this.executeStarted = new Promise<void>((resolve) => { this.resolveExecuteStarted = resolve; });
  }

  public override async executeCommand(input: Parameters<FakeAgentRuntime['executeCommand']>[0]): Promise<Awaited<ReturnType<FakeAgentRuntime['executeCommand']>>> {
    this.resolveExecuteStarted();
    await new Promise<void>((resolve) => { this.releaseExecution = resolve; });
    return super.executeCommand(input);
  }

  public release(): void { this.releaseExecution(); }
}

interface CommandAppFixture {
  readonly app: express.Express;
  readonly project: ProjectFixture;
  readonly runtime: FakeAgentRuntime;
  readonly proposal: Awaited<ReturnType<ProposeSandboxCommandUseCase['execute']>>['resource'];
  readonly blocked: Awaited<ReturnType<ProposeSandboxCommandUseCase['execute']>>['resource'];
  readonly rejected: Awaited<ReturnType<ProposeSandboxCommandUseCase['execute']>>['resource'];
}

async function buildFixture(runtime: FakeAgentRuntime = new FakeAgentRuntime()): Promise<CommandAppFixture> {
  const project = new ProjectFixture();
  const runs = new ReadyRunFixture();
  const commands = new InMemorySandboxCommandRepository();
  const propose = new ProposeSandboxCommandUseCase(runs, commands, runtime, project);
  const proposal = await propose.execute({ ownerId: OWNER_ID, runId: RUN_ID, command: 'pwd', args: [], idempotencyKey: 'proposal-safe' });
  const blocked = await propose.execute({ ownerId: OWNER_ID, runId: RUN_ID, command: 'powershell', args: ['Get-ChildItem'], idempotencyKey: 'proposal-blocked' });
  const rejected = await propose.execute({ ownerId: OWNER_ID, runId: RUN_ID, command: 'ls', args: [], idempotencyKey: 'proposal-rejected' });
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  const getSession = {
    execute: jest.fn(async (rawToken: string | undefined) => {
      if (rawToken !== 'valid-session-token') {
        throw new UnauthenticatedError();
      }
      return { sessionId: 'session', principal: { id: OWNER_ID, displayName: 'Local user', accountKind: 'regular', role: 'admin' }, csrfToken: 'csrf-token', expiresAt: new Date(Date.now() + 60_000) };
    })
  } as unknown as GetSessionUseCase;
  const app = createApp({
    logger: createLogger('silent'),
    readiness: new GetReadinessUseCase(readiness),
    appVersion: 'test',
    sandboxCommands: {
      getSession,
      listCommands: new ListSandboxCommandsUseCase(runs, commands, project),
      getCommand: new GetSandboxCommandUseCase(runs, commands, project),
      decideCommand: new DecideSandboxCommandUseCase(runs, commands, runtime, project),
      cancelCommand: new CancelSandboxCommandUseCase(runs, commands, runtime, project),
      appOrigin: APP_ORIGIN,
      clearSessionCookie: () => undefined
    }
  });
  return { app, project, runtime, proposal: proposal.resource, blocked: blocked.resource, rejected: rejected.resource };
}

function authenticatedHeaders(origin = APP_ORIGIN, csrf = 'csrf-token'): Record<string, string> {
  return { Origin: origin, Cookie: '__Host-pa_session=valid-session-token', 'X-CSRF-Token': csrf };
}

describe('sandbox command router (integration)', () => {
  it('returns safe DTOs, enforces UUID validation, and hides cross-owner resources', async () => {
    const fixture = await buildFixture();
    const headers = authenticatedHeaders();

    await request(fixture.app).get(`/api/v1/ai-runs/${RUN_ID}/commands`).set(headers).expect(200).expect(({ body }) => {
      expect(body.data.commands[0]).toMatchObject({ runId: RUN_ID, command: 'pwd', summary: expect.any(String) });
      expect(body.data.commands[0]).not.toHaveProperty('ownerId');
      expect(body.data.commands[0]).not.toHaveProperty('args');
      expect(JSON.stringify(body)).not.toContain('stagedReference');
    });
    await request(fixture.app).get('/api/v1/ai-runs/not-a-uuid/commands').set(headers).expect(400).expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));
    await request(fixture.app).get(`/api/v1/ai-runs/${OTHER_RUN_ID}/commands`).set(headers).expect(404).expect(({ body }) => expect(body.error.code).toBe('COMMAND_NOT_FOUND'));
    await request(fixture.app).get(`/api/v1/ai-runs/${RUN_ID}/commands/not-a-uuid`).set(headers).expect(400).expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));
    await request(fixture.app).get(`/api/v1/ai-runs/${RUN_ID}/commands/99999999-9999-4999-8999-999999999999`).set(headers).expect(404).expect(({ body }) => expect(body.error.code).toBe('COMMAND_NOT_FOUND'));
  });

  it('enforces authentication, origin, CSRF, exact proposal hashes, and decision idempotency', async () => {
    const fixture = await buildFixture();
    const headers = authenticatedHeaders();
    const path = `/api/v1/ai-runs/${RUN_ID}/commands/${fixture.proposal.id}/decision`;
    const payload = { proposalHash: fixture.proposal.proposalHash, decision: 'approve' };

    await request(fixture.app).post(path).set('Origin', APP_ORIGIN).send(payload).expect(401);
    await request(fixture.app).post(path).set(authenticatedHeaders('https://evil.invalid')).set('Idempotency-Key', 'decision-origin').send(payload).expect(403);
    await request(fixture.app).post(path).set({ Cookie: authenticatedHeaders().Cookie, Origin: APP_ORIGIN }).set('Idempotency-Key', 'decision-csrf').send(payload).expect(403);
    await request(fixture.app).post(path).set(headers).set('Idempotency-Key', 'decision-stale').send({ ...payload, proposalHash: 'b'.repeat(64) }).expect(409).expect(({ body }) => expect(body.error.code).toBe('COMMAND_PROPOSAL_CONFLICT'));

    await request(fixture.app).post(path).set(headers).set('Idempotency-Key', 'decision-approve').send(payload).expect(200).expect(({ body }) => expect(body.data.command.status).toBe('completed'));
    expect(fixture.runtime.executedCommands).toHaveLength(1);
    await request(fixture.app).post(path).set(headers).set('Idempotency-Key', 'decision-approve').send(payload).expect(200);
    expect(fixture.runtime.executedCommands).toHaveLength(1);
    await request(fixture.app).post(path).set(headers).set('Idempotency-Key', 'decision-approve').send({ ...payload, decision: 'reject' }).expect(409);
  });

  it('rejects blocked approval, records rejection, and never executes either command', async () => {
    const fixture = await buildFixture();
    const headers = authenticatedHeaders();
    const blockedPath = `/api/v1/ai-runs/${RUN_ID}/commands/${fixture.blocked.id}/decision`;
    await request(fixture.app).post(blockedPath).set(headers).set('Idempotency-Key', 'blocked-decision').send({ proposalHash: fixture.blocked.proposalHash, decision: 'approve' }).expect(409).expect(({ body }) => expect(body.error.code).toBe('COMMAND_BLOCKED'));
    const rejectedPath = `/api/v1/ai-runs/${RUN_ID}/commands/${fixture.rejected.id}/decision`;
    await request(fixture.app).post(rejectedPath).set(headers).set('Idempotency-Key', 'reject-decision').send({ proposalHash: fixture.rejected.proposalHash, decision: 'reject' }).expect(200).expect(({ body }) => expect(body.data.command.status).toBe('rejected'));
    expect(fixture.runtime.executedCommands).toHaveLength(0);
  });

  it('blocks command mutations after the project is archived while retaining read access', async () => {
    const fixture = await buildFixture();
    fixture.project.status = 'archived';
    const headers = authenticatedHeaders();
    const decisionPath = `/api/v1/ai-runs/${RUN_ID}/commands/${fixture.proposal.id}/decision`;
    const cancelPath = `/api/v1/ai-runs/${RUN_ID}/commands/${fixture.proposal.id}/cancel`;

    await request(fixture.app).get(`/api/v1/ai-runs/${RUN_ID}/commands/${fixture.proposal.id}`).set(headers).expect(200);
    await request(fixture.app).post(decisionPath).set(headers).set('Idempotency-Key', 'decision-archived').send({ proposalHash: fixture.proposal.proposalHash, decision: 'approve' }).expect(409).expect(({ body }) => expect(body.error.code).toBe('PROJECT_ARCHIVED'));
    await request(fixture.app).post(cancelPath).set(headers).set('Idempotency-Key', 'cancel-archived').send({}).expect(409).expect(({ body }) => expect(body.error.code).toBe('PROJECT_ARCHIVED'));
    expect(fixture.runtime.executedCommands).toHaveLength(0);
  });

  it('returns 202 for cancellation and reconciles a late fake result as cancelled', async () => {
    const runtime = new PausingRuntime();
    const fixture = await buildFixture(runtime);
    const headers = authenticatedHeaders();
    const approvePath = `/api/v1/ai-runs/${RUN_ID}/commands/${fixture.proposal.id}/decision`;
    const approval = request(fixture.app).post(approvePath).set(headers).set('Idempotency-Key', 'decision-pause').send({ proposalHash: fixture.proposal.proposalHash, decision: 'approve' });
    const approvalResult = approval.then((response) => response);
    await runtime.executeStarted;
    const cancelPath = `/api/v1/ai-runs/${RUN_ID}/commands/${fixture.proposal.id}/cancel`;
    await request(fixture.app).post(cancelPath).set(headers).set('Idempotency-Key', 'cancel-pause').send({}).expect(202).expect(({ body }) => expect(body.data.command.status).toBe('cancel_requested'));
    runtime.release();
    await approvalResult;
    await request(fixture.app).get(`/api/v1/ai-runs/${RUN_ID}/commands/${fixture.proposal.id}`).set(headers).expect(200).expect(({ body }) => expect(body.data.command.status).toBe('cancelled'));
  });
});
