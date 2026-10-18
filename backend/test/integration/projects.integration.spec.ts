import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import { clearSessionCookie } from '@/modules/auth';
import type { LocalUserRecord, SessionRecord } from '@/modules/auth/domain/auth-types';
import { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { LoginUseCase } from '@/modules/auth/use-cases/login';
import { LogoutUseCase } from '@/modules/auth/use-cases/logout';
import type { IClock, ILoginRateLimiter, IOpaqueTokenProvider, IPasswordHasher } from '@/modules/auth/repositories/security-providers';
import type { CreateSessionInput, ISessionRepository } from '@/modules/auth/repositories/session-repository';
import type { CreateRegularAccountInput, IUserRepository } from '@/modules/auth/repositories/user-repository';
import { ProjectIdempotencyKeyInvalidError, ProjectNotFoundError, ProjectRemovalBusyError, ProjectRootReparsePointError, ProjectVersionConflictError, WorkspaceBoundaryUnavailableError, WorkspaceStorageUnavailableError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import { CreateProjectUseCase, DeleteProjectUseCase, GetProjectOverviewUseCase, GetProjectUseCase, ListProjectsUseCase, UpdateProjectStatusUseCase } from '@/modules/projects';
import type {
  AttachInitialProjectRootInput,
  CreatePlanningProjectInput,
  IWorkspacePlanningUseCases,
  ProjectActionResult,
  ReuseProjectInput,
  SearchProjectMetadataInput,
  UpdateProjectObjectiveInput
} from '@/modules/projects/use-cases/workspace-planning-use-cases';
import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';
import type { RemoveProjectRecord } from '@/modules/projects/repositories/project-removal-repository';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { GetReadinessUseCase } from '@/modules/health';
import { createLogger } from '@/shared/logging/logger';

const APP_ORIGIN = 'https://127.0.0.1:8443';
const NOW = new Date('2026-09-12T12:00:00.000Z');
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RAW_TOKEN = 'opaque-token-value-with-valid-length-123456';

const activeProject: Project = {
  id: PROJECT_ID,
  ownerId: 'user-1',
  name: 'Existing app',
  slug: 'existing-app',
  relativeRoot: 'apps',
  storageKind: 'legacy',
  objective: null,
  status: 'active',
  version: 1,
  createdAt: NOW,
  updatedAt: NOW
};

class FixtureProjectRepository implements IProjectRepository {
  private readonly records = new Map<string, Project>([[activeProject.id, activeProject]]);
  public busy = false;

  public async remove(input: RemoveProjectRecord): Promise<void> {
    const project = await this.findByIdForOwner(input.ownerId, input.projectId);
    if (!project) throw new ProjectNotFoundError();
    if (project.version !== input.expectedVersion) throw new ProjectVersionConflictError();
    if (this.busy) throw new ProjectRemovalBusyError();
    this.records.delete(input.projectId);
  }

  public async listByOwner(ownerId: string, includeArchived: boolean): Promise<readonly Project[]> {
    return [...this.records.values()].filter((project) => project.ownerId === ownerId && (includeArchived || project.status === 'active'));
  }

  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> {
    const project = this.records.get(projectId);
    return project?.ownerId === ownerId ? project : null;
  }

  public async listActiveRoots(ownerId: string): Promise<readonly string[]> {
    return [...this.records.values()].filter((project) => project.ownerId === ownerId && project.status === 'active').flatMap((project) => project.relativeRoot === null ? [] : [project.relativeRoot]);
  }

  public async create(input: import('@/modules/projects/repositories/project-repository').CreateProjectRecord): Promise<Project> {
    const created: Project = { ...input, id: '22222222-2222-4222-8222-222222222222', status: 'active', version: 1, createdAt: NOW, updatedAt: NOW };
    this.records.set(created.id, created);
    return created;
  }

  public async updateStatus(input: { readonly ownerId: string; readonly projectId: string; readonly status: 'active' | 'archived'; readonly expectedVersion: number }): Promise<Project | null> {
    const current = await this.findByIdForOwner(input.ownerId, input.projectId);
    if (!current || current.version !== input.expectedVersion) {
      return null;
    }
    const updated = { ...current, status: input.status, version: current.version + 1, updatedAt: NOW };
    this.records.set(updated.id, updated);
    return updated;
  }
}

class FixtureWorkspaceBoundary implements IWorkspaceBoundary {
  public available = true;

  public async getSnapshot(): Promise<{ status: 'ready' | 'unavailable' }> {
    return this.available ? { status: 'ready' } : { status: 'unavailable' };
  }

  public async assertReady(): Promise<void> {
    if (!this.available) {
      throw new WorkspaceBoundaryUnavailableError();
    }
  }

  public async getManagedSnapshot(): Promise<{ status: 'ready' | 'unavailable' }> {
    return this.available ? { status: 'ready' } : { status: 'unavailable' };
  }

  public async createManagedProjectRoot(_ownerId: string, projectId: string): Promise<string> {
    if (!this.available) throw new WorkspaceStorageUnavailableError();
    return `projects/${projectId}`;
  }

  public async validateProjectRoot(relativeRoot: string): Promise<string> {
    if (relativeRoot === 'links') {
      throw new ProjectRootReparsePointError();
    }
    return relativeRoot;
  }
}

class FixtureUserRepository implements IUserRepository {
  private readonly user: LocalUserRecord = { id: 'user-1', displayName: 'Local user', identifier: 'owner', accountKind: 'regular', role: 'admin', passwordHash: 'stored-hash', isActive: true, expiresAt: null };

  public async findByIdentifier(identifier: string): Promise<LocalUserRecord | null> {
    return identifier === 'owner' ? this.user : null;
  }

  public async findById(userId: string): Promise<LocalUserRecord | null> {
    return userId === 'user-1' ? this.user : null;
  }

  public async findBootstrapOwnerId(): Promise<string | null> { return this.user.id; }

  public async hasAnyRegularAccounts(): Promise<boolean> { return true; }

  public async createRegularAccount(_input: CreateRegularAccountInput): Promise<LocalUserRecord> {
    throw new Error('Not used by project integration fixtures.');
  }

  public async bootstrapInitialAdmin(): Promise<boolean> { return false; }

  public async disableAccount(): Promise<'disabled'> { return 'disabled'; }
}

class FixtureSessionRepository implements ISessionRepository {
  private readonly records = new Map<string, SessionRecord>();

  public async create(input: CreateSessionInput): Promise<Pick<SessionRecord, 'id' | 'userId' | 'expiresAt'>> {
    this.records.set(input.tokenHash, { id: 'session-1', userId: input.userId, displayName: 'Local user', accountKind: 'regular', role: 'admin', accountExpiresAt: null, expiresAt: input.expiresAt, revokedAt: null });
    return { id: 'session-1', userId: input.userId, expiresAt: input.expiresAt };
  }

  public async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.records.get(tokenHash) ?? null;
  }

  public async revoke(sessionId: string): Promise<void> {
    for (const [token, session] of this.records.entries()) {
      if (session.id === sessionId) {
        this.records.set(token, { ...session, revokedAt: NOW });
      }
    }
  }
}

class FixtureTokenProvider implements IOpaqueTokenProvider {
  public createToken(): string { return RAW_TOKEN; }
  public digestToken(token: string): string { return `hash:${token}`; }
  public createCsrfToken(token: string): string { return `csrf:${token}`; }
}

class FixtureClock implements IClock { public now(): Date { return NOW; } }
class FixturePasswordHasher implements IPasswordHasher {
  public async hash(password: string): Promise<string> { return `hash:${password}`; }
  public async verify(password: string, hash: string): Promise<boolean> { return password === 'correct-password' && hash === 'stored-hash'; }
}
class FixtureRateLimiter implements ILoginRateLimiter { public consume(): boolean { return true; } }

function planningFixture(project: Project = activeProject): IWorkspacePlanningUseCases {
  const makeReceipt = (target: Project): ActionLedgerRecord => ({
    id: '33333333-3333-4333-8333-333333333333',
    ownerId: 'user-1',
    operationKey: 'planning-key',
    requestFingerprint: 'fingerprint',
    actorKind: 'manual',
    turnId: null,
    targetKind: 'workspace',
    targetId: target.id,
    actionKind: 'workspace.create',
    expectedVersion: null,
    undoOfActionId: null,
    preVersion: null,
    postVersion: target.version,
    reversibleFields: {},
    outcome: { targetId: target.id, targetVersion: target.version },
    undoStatus: 'available',
    undoActionId: null,
    createdAt: NOW.toISOString()
  });
  const action = async (target: Project = project, replayed = false): Promise<ProjectActionResult> => ({ project: target, receipt: makeReceipt(target), replayed });
  const createdPlanningProject: Project = {
    ...project,
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Plan',
    slug: 'plan',
    relativeRoot: null,
    storageKind: null,
    version: 1
  };
  const secondSearchProject: Project = { ...project, id: '55555555-5555-4555-8555-555555555555', name: `${project.name} copy` };
  return {
    search: jest.fn(async ({ limit }: SearchProjectMetadataInput) => ({ projects: [project, secondSearchProject], limit, hasMore: false })),
    reuse: jest.fn(async (_input: ReuseProjectInput) => project),
    createPlanning: jest.fn(async (input: CreatePlanningProjectInput) => {
      if (typeof input.operationKey !== 'string' || !input.operationKey.trim()) {
        throw new ProjectIdempotencyKeyInvalidError();
      }
      return action(createdPlanningProject);
    }),
    updateObjective: jest.fn(async (_input: UpdateProjectObjectiveInput) => action()),
    attachInitialRoot: jest.fn(async (_input: AttachInitialProjectRootInput) => action())
  };
}

function buildApp(boundary: FixtureWorkspaceBoundary, projectRepository = new FixtureProjectRepository(), workspacePlanning: IWorkspacePlanningUseCases = planningFixture()): express.Express {
  const users = new FixtureUserRepository();
  const sessions = new FixtureSessionRepository();
  const tokenProvider = new FixtureTokenProvider();
  const clock = new FixtureClock();
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  const getSession = new GetSessionUseCase(sessions, tokenProvider, clock);
  return createApp({
    logger: createLogger('silent'),
    readiness: new GetReadinessUseCase(readiness),
    appVersion: 'test',
    auth: {
      login: new LoginUseCase(users, sessions, new FixturePasswordHasher(), tokenProvider, clock, { sessionLifetimeMs: 60_000 }),
      getSession,
      logout: new LogoutUseCase(sessions),
      appOrigin: APP_ORIGIN,
      cookieSecure: true,
      sessionLifetimeMs: 60_000,
      rateLimiter: new FixtureRateLimiter()
    },
    projects: {
      getSession,
      workspaceBoundary: boundary,
      createProject: new CreateProjectUseCase(projectRepository, boundary),
      listProjects: new ListProjectsUseCase(projectRepository),
      getProject: new GetProjectUseCase(projectRepository),
      updateProjectStatus: new UpdateProjectStatusUseCase(projectRepository, boundary),
      workspacePlanning,
      deleteProject: new DeleteProjectUseCase(projectRepository),
      getOverview: new GetProjectOverviewUseCase({ getOverview: async (ownerId) => ({
        projects: (await projectRepository.listByOwner(ownerId, false)).map((project) => ({ ...project, lastActivityAt: NOW })),
        tasks: []
      }) }),
      appOrigin: APP_ORIGIN,
      clearSessionCookie: (response) => clearSessionCookie(response, true)
    }
  });
}

function cookiePair(response: request.Response): string {
  const value = response.headers['set-cookie'];
  const cookies = typeof value === 'string' ? [value] : value ?? [];
  const sessionCookie = cookies.find((cookie) => cookie.startsWith('__Host-pa_session='));
  if (!sessionCookie) {
    throw new Error('Fixture login did not set a session cookie.');
  }
  return sessionCookie.split(';')[0] ?? sessionCookie;
}

async function login(app: express.Express): Promise<{ cookie: string; csrf: string }> {
  const response = await request(app).post('/api/v1/auth/login').set('Origin', APP_ORIGIN).send({ identifier: 'owner', password: 'correct-password' }).expect(200);
  return { cookie: cookiePair(response), csrf: response.body.data.csrfToken as string };
}

describe('projects API (integration)', () => {
  it('returns the Home overview before the dynamic project route, without owner IDs', async () => {
    const app = buildApp(new FixtureWorkspaceBoundary());
    await request(app).get('/api/v1/projects/overview').expect(401);
    const session = await login(app);
    const overview = await request(app).get('/api/v1/projects/overview?taskLimit=6').set('Cookie', session.cookie).expect(200);
    expect(overview.body.data.projects[0]).toMatchObject({ id: PROJECT_ID, lastActivityAt: NOW.toISOString() });
    expect(overview.body.data.projects[0]).not.toHaveProperty('ownerId');
    expect(overview.body.data.tasks).toEqual([]);
    await request(app).get('/api/v1/projects/overview?taskLimit=101').set('Cookie', session.cookie).expect(400);
    await request(app).get('/api/v1/projects/overview?taskLimit=6&taskLimit=7').set('Cookie', session.cookie).expect(400);
  });

  it('requires origin, CSRF, authentication and current version for permanent project removal', async () => {
    const app = buildApp(new FixtureWorkspaceBoundary());
    const endpoint = `/api/v1/projects/${PROJECT_ID}`;
    const session = await login(app);
    await request(app).delete(endpoint).set('Origin', APP_ORIGIN).expect(401);
    await request(app).delete(endpoint).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).expect(403);
    await request(app).delete(endpoint).set('Origin', APP_ORIGIN).set('Cookie', session.cookie).expect(403);
    await request(app).delete(endpoint).set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).expect(400);
    await request(app).delete(endpoint).set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('If-Match', '2').expect(409);
    await request(app).delete(endpoint).set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('If-Match', '1').expect(204);
    await request(app).get(endpoint).set('Cookie', session.cookie).expect(404);
  });

  it('blocks busy projects and hides guessed removal IDs', async () => {
    const projects = new FixtureProjectRepository();
    projects.busy = true;
    const app = buildApp(new FixtureWorkspaceBoundary(), projects);
    const session = await login(app);
    await request(app).delete(`/api/v1/projects/${PROJECT_ID}`).set('Origin', APP_ORIGIN).set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf).set('If-Match', '1').expect(409).expect(({ body }) => expect(body.error.code).toBe('PROJECT_REMOVAL_BUSY'));
    await request(app).delete('/api/v1/projects/99999999-9999-4999-8999-999999999999').set('Origin', APP_ORIGIN).set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf).set('If-Match', '1').expect(404);
  });

  it('lists without exposing host roots, rejects caller-supplied roots, and hides guessed IDs', async () => {
    const boundary = new FixtureWorkspaceBoundary();
    const app = buildApp(boundary);
    const session = await login(app);

    await request(app).get('/api/v1/projects').set('Cookie', session.cookie).expect(200).expect(({ body }) => {
      expect(body.data.projects[0]).toMatchObject({ workspaceMode: 'file_backed', capabilities: { planning: true, fileAccess: true }, status: 'active' });
      expect(body.data.projects[0]).not.toHaveProperty('relativeRoot');
      expect(body.data.projects[0]).not.toHaveProperty('storageKind');
      expect(JSON.stringify(body)).not.toContain('/workspace');
      expect(JSON.stringify(body)).not.toContain('C:\\');
    });
    await request(app).post('/api/v1/projects').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: 'Escape', relativeRoot: '../outside' }).expect(400).expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));
    await request(app).post('/api/v1/projects').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: 'Child', relativeRoot: 'apps/site' }).expect(400).expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));
    await request(app).get('/api/v1/projects/99999999-9999-4999-8999-999999999999').set('Cookie', session.cookie).expect(404).expect(({ body }) => expect(body).toEqual({ data: null, error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found.' } }));
  });

  it('creates, archives with CSRF/version protection, and rejects stale status changes', async () => {
    const app = buildApp(new FixtureWorkspaceBoundary());
    const session = await login(app);
    const created = await request(app).post('/api/v1/projects').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: 'Notes' }).expect(201);
    expect(created.body.data).toMatchObject({ name: 'Notes', workspaceMode: 'file_backed', capabilities: { planning: true, fileAccess: true }, status: 'active', version: 1 });
    expect(created.body.data).not.toHaveProperty('relativeRoot');
    expect(created.body.data).not.toHaveProperty('storageKind');
    await request(app).patch(`/api/v1/projects/${created.body.data.id}`).set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('If-Match', '1').send({ status: 'archived' }).expect(200).expect(({ body }) => expect(body.data).toMatchObject({ status: 'archived', version: 2 }));
    await request(app).patch(`/api/v1/projects/${created.body.data.id}`).set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('If-Match', '1').send({ status: 'active' }).expect(409).expect(({ body }) => expect(body.error.code).toBe('PROJECT_VERSION_CONFLICT'));
  });

  it('keeps project metadata readable when the workspace identity is unavailable', async () => {
    const boundary = new FixtureWorkspaceBoundary();
    boundary.available = false;
    const app = buildApp(boundary);
    const session = await login(app);
    await request(app).get('/api/v1/projects').set('Cookie', session.cookie).expect(200);
    await request(app).get(`/api/v1/projects/${PROJECT_ID}`).set('Cookie', session.cookie).expect(200);
    const planning = await request(app).post('/api/v1/projects').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
      .send({ name: 'Launch plan', workspaceMode: 'planning', objective: '  Track the launch  ' }).expect(201);
    expect(planning.body.data).toMatchObject({
      objective: 'Track the launch',
      workspaceMode: 'planning',
      capabilities: { planning: true, fileAccess: false }
    });
    expect(planning.body.data).not.toHaveProperty('relativeRoot');
    expect(planning.body.data).not.toHaveProperty('storageKind');
    await request(app).get(`/api/v1/projects/${planning.body.data.id}`).set('Cookie', session.cookie).expect(200)
      .expect(({ body }) => expect(body.data).toMatchObject({ workspaceMode: 'planning', objective: 'Track the launch' }));
    await request(app).post('/api/v1/projects').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
      .send({ name: 'Unready' }).expect(503).expect(({ body }) => expect(body.error.code).toBe('WORKSPACE_STORAGE_UNAVAILABLE'));
  });

  it('rejects caller-supplied roots while defaulting project creation to file-backed mode', async () => {
    const app = buildApp(new FixtureWorkspaceBoundary());
    const session = await login(app);
    await request(app).post('/api/v1/projects').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
      .send({ name: 'Wrong mode', workspaceMode: 'planning', relativeRoot: 'notes' }).expect(400).expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));
    await request(app).post('/api/v1/projects').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
      .send({ name: 'Default mode' }).expect(201).expect(({ body }) => expect(body.data).toMatchObject({ workspaceMode: 'file_backed', capabilities: { fileAccess: true } }));
  });

  it('exposes bounded metadata search, explicit reuse, and idempotent mutation headers', async () => {
    const planning = planningFixture();
    const app = buildApp(new FixtureWorkspaceBoundary(), new FixtureProjectRepository(), planning);
    const session = await login(app);

    const search = await request(app).get('/api/v1/projects/search?query=launch&limit=5').set('Cookie', session.cookie).expect(200);
    expect(search.body.data).toMatchObject({ limit: 5, hasMore: false, ambiguous: true });
    expect(search.body.data.projects).toHaveLength(2);
    expect(search.body.data.projects[0]).toMatchObject({ id: PROJECT_ID, name: 'Existing app', version: 1 });
    expect(search.body.data.projects[0]).not.toHaveProperty('relativeRoot');
    expect(search.body.data.projects[0]).not.toHaveProperty('ownerId');
    await request(app).get('/api/v1/projects/search?query=x').set('Cookie', session.cookie).expect(400);

    await request(app).post('/api/v1/projects/reuse').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
      .send({ projectId: PROJECT_ID }).expect(200).expect(({ body }) => expect(body.data).toMatchObject({ id: PROJECT_ID, workspaceMode: 'file_backed' }));
    expect(planning.reuse).toHaveBeenCalledWith({ ownerId: 'user-1', projectId: PROJECT_ID });

    await request(app).post('/api/v1/projects/planning').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
      .send({ name: 'Plan' }).expect(400).expect(({ body }) => expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED'));
    await request(app).post('/api/v1/projects/planning').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
      .set('Idempotency-Key', 'plan-operation-1').send({ name: 'Plan' }).expect(201).expect(({ body }) => {
        expect(body.data).toMatchObject({ replayed: false, project: { id: '44444444-4444-4444-8444-444444444444', workspaceMode: 'planning', capabilities: { fileAccess: false } }, receipt: { actionKind: 'workspace.create' } });
        expect(body.data.project).not.toHaveProperty('relativeRoot');
      });
    expect(planning.createPlanning).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'user-1', operationKey: 'plan-operation-1', name: 'Plan' }));

    await request(app).patch(`/api/v1/projects/${PROJECT_ID}/objective`).set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
      .set('Idempotency-Key', 'objective-operation-1').send({ objective: 'Improve the app' }).expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('PROJECT_VERSION_REQUIRED'));
    await request(app).patch(`/api/v1/projects/${PROJECT_ID}/root-attachment`).set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
      .set('If-Match', '1').set('Idempotency-Key', 'root-operation-1').send({ relativeRoot: '.' }).expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('VALIDATION_ERROR'));
    expect(planning.attachInitialRoot).not.toHaveBeenCalled();
  });
});
