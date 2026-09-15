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
import type { CreateLocalUserInput, IUserRepository } from '@/modules/auth/repositories/user-repository';
import { ProjectRootReparsePointError, WorkspaceBoundaryUnavailableError } from '@/modules/projects/domain/project-errors';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import { CreateProjectUseCase, GetProjectUseCase, ListProjectsUseCase, UpdateProjectStatusUseCase } from '@/modules/projects';
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
  status: 'active',
  version: 1,
  createdAt: NOW,
  updatedAt: NOW
};

class FixtureProjectRepository implements IProjectRepository {
  private readonly records = new Map<string, Project>([[activeProject.id, activeProject]]);

  public async listByOwner(ownerId: string, includeArchived: boolean): Promise<readonly Project[]> {
    return [...this.records.values()].filter((project) => project.ownerId === ownerId && (includeArchived || project.status === 'active'));
  }

  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> {
    const project = this.records.get(projectId);
    return project?.ownerId === ownerId ? project : null;
  }

  public async listActiveRoots(ownerId: string): Promise<readonly string[]> {
    return [...this.records.values()].filter((project) => project.ownerId === ownerId && project.status === 'active').map((project) => project.relativeRoot);
  }

  public async create(input: { readonly ownerId: string; readonly name: string; readonly slug: string; readonly relativeRoot: string }): Promise<Project> {
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

  public async validateProjectRoot(relativeRoot: string): Promise<string> {
    if (relativeRoot === 'links') {
      throw new ProjectRootReparsePointError();
    }
    return relativeRoot;
  }
}

class FixtureUserRepository implements IUserRepository {
  public async findActiveLocalUser(): Promise<LocalUserRecord> {
    return { id: 'user-1', displayName: 'Local user', passwordHash: 'stored-hash', isActive: true };
  }

  public async findActiveLocalUserById(): Promise<LocalUserRecord> {
    return { id: 'user-1', displayName: 'Local user', passwordHash: 'stored-hash', isActive: true };
  }

  public async createLocalUser(_input: CreateLocalUserInput): Promise<LocalUserRecord> {
    throw new Error('Not used by project integration fixtures.');
  }
}

class FixtureSessionRepository implements ISessionRepository {
  private readonly records = new Map<string, SessionRecord>();

  public async create(input: CreateSessionInput): Promise<Pick<SessionRecord, 'id' | 'userId' | 'expiresAt'>> {
    this.records.set(input.tokenHash, { id: 'session-1', userId: input.userId, displayName: 'Local user', expiresAt: input.expiresAt, revokedAt: null });
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

function buildApp(boundary: FixtureWorkspaceBoundary): express.Express {
  const users = new FixtureUserRepository();
  const sessions = new FixtureSessionRepository();
  const tokenProvider = new FixtureTokenProvider();
  const clock = new FixtureClock();
  const projectRepository = new FixtureProjectRepository();
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
      createProject: new CreateProjectUseCase(projectRepository, boundary),
      listProjects: new ListProjectsUseCase(projectRepository, boundary),
      getProject: new GetProjectUseCase(projectRepository, boundary),
      updateProjectStatus: new UpdateProjectStatusUseCase(projectRepository, boundary),
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
  const response = await request(app).post('/api/v1/auth/login').set('Origin', APP_ORIGIN).send({ password: 'correct-password' }).expect(200);
  return { cookie: cookiePair(response), csrf: response.body.data.csrfToken as string };
}

describe('projects API (integration)', () => {
  it('lists safely, rejects traversal and overlap, and hides guessed IDs', async () => {
    const boundary = new FixtureWorkspaceBoundary();
    const app = buildApp(boundary);
    const session = await login(app);

    await request(app).get('/api/v1/projects').set('Cookie', session.cookie).expect(200).expect(({ body }) => {
      expect(body.data.projects[0]).toMatchObject({ relativeRoot: 'apps', status: 'active' });
      expect(JSON.stringify(body)).not.toContain('/workspace');
      expect(JSON.stringify(body)).not.toContain('C:\\');
    });
    await request(app).post('/api/v1/projects').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: 'Escape', relativeRoot: '../outside' }).expect(400).expect(({ body }) => expect(body.error.code).toBe('PROJECT_ROOT_INVALID'));
    await request(app).post('/api/v1/projects').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: 'Child', relativeRoot: 'apps/site' }).expect(409).expect(({ body }) => expect(body.error.code).toBe('PROJECT_ROOT_OVERLAP'));
    await request(app).get('/api/v1/projects/99999999-9999-4999-8999-999999999999').set('Cookie', session.cookie).expect(404).expect(({ body }) => expect(body).toEqual({ data: null, error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found.' } }));
  });

  it('creates, archives with CSRF/version protection, and rejects stale status changes', async () => {
    const app = buildApp(new FixtureWorkspaceBoundary());
    const session = await login(app);
    const created = await request(app).post('/api/v1/projects').set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ name: 'Notes', relativeRoot: 'notes' }).expect(201);
    expect(created.body.data).toMatchObject({ name: 'Notes', relativeRoot: 'notes', status: 'active', version: 1 });
    await request(app).patch(`/api/v1/projects/${created.body.data.id}`).set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('If-Match', '1').send({ status: 'archived' }).expect(200).expect(({ body }) => expect(body.data).toMatchObject({ status: 'archived', version: 2 }));
    await request(app).patch(`/api/v1/projects/${created.body.data.id}`).set('Origin', APP_ORIGIN).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).set('If-Match', '1').send({ status: 'active' }).expect(409).expect(({ body }) => expect(body.error.code).toBe('PROJECT_VERSION_CONFLICT'));
  });

  it('fails closed when the workspace identity is unavailable', async () => {
    const boundary = new FixtureWorkspaceBoundary();
    boundary.available = false;
    const app = buildApp(boundary);
    const session = await login(app);
    await request(app).get('/api/v1/projects').set('Cookie', session.cookie).expect(503).expect(({ body }) => expect(body.error.code).toBe('WORKSPACE_BOUNDARY_UNAVAILABLE'));
  });
});

