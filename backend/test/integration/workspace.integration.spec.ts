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
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { WorkspaceGatewayAdapter } from '@/infrastructure/workspace/workspace-gateway';
import type { WorkspaceGatewayFileHandle, WorkspaceGatewayFileSystem, WorkspaceGatewayStats } from '@/infrastructure/workspace/workspace-gateway-fs';
import { GetReadinessUseCase } from '@/modules/health';
import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import { ListWorkspaceFilesUseCase, ReadWorkspaceTextUseCase, SearchWorkspaceTextUseCase, TreeWorkspaceFilesUseCase } from '@/modules/files';
import { createLogger } from '@/shared/logging/logger';
import { WorkspaceBoundaryUnavailableError } from '@/modules/projects/domain/project-errors';

const APP_ORIGIN = 'https://127.0.0.1:8443';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const RAW_TOKEN = 'opaque-token-value-with-valid-length-123456';
const NOW = new Date('2026-09-12T12:00:00.000Z');

const activeProject: Project = {
  id: PROJECT_ID,
  ownerId: 'user-1',
  name: 'Workspace',
  slug: 'workspace',
  relativeRoot: 'apps',
  objective: null,
  status: 'active',
  version: 1,
  createdAt: NOW,
  updatedAt: NOW
};

class ProjectFixture implements IProjectRepository {
  public async listByOwner(): Promise<readonly Project[]> { return [activeProject]; }
  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> {
    return ownerId === activeProject.ownerId && projectId === activeProject.id ? activeProject : null;
  }
  public async listActiveRoots(): Promise<readonly string[]> { return ['apps']; }
  public async create(input: import('@/modules/projects/repositories/project-repository').CreateProjectRecord): Promise<Project> { return { ...activeProject, ...input }; }
  public async updateStatus(): Promise<Project | null> { return null; }
}

function stat(options: { directory?: boolean; file?: boolean; symbolicLink?: boolean; size?: number }): WorkspaceGatewayStats {
  return {
    ...(options.size === undefined ? {} : { size: options.size }),
    isDirectory: () => options.directory === true,
    isFile: () => options.file === true,
    isSymbolicLink: () => options.symbolicLink === true
  };
}

class BoundaryFixture implements IWorkspaceBoundary {
  public available = true;
  public async getSnapshot(): Promise<{ status: 'ready' | 'unavailable' }> { return this.available ? { status: 'ready' } : { status: 'unavailable' }; }
  public async assertReady(): Promise<void> { if (!this.available) throw new WorkspaceBoundaryUnavailableError(); }
  public async validateProjectRoot(root: string): Promise<string> { await this.assertReady(); return root; }
}

class FileSystemFixture implements WorkspaceGatewayFileSystem {
  private readonly records = new Map<string, { readonly stats: WorkspaceGatewayStats; readonly content?: Buffer; readonly children?: readonly string[] }>();

  public constructor() {
    this.directory('/workspace', ['apps']);
    this.directory('/workspace/apps', ['src', '.env', 'binary.txt']);
    this.directory('/workspace/apps/src', ['main.ts']);
    this.file('/workspace/apps/src/main.ts', 'hello 世界\n');
    this.file('/workspace/apps/.env', 'PASSWORD=never-return\n');
    this.file('/workspace/apps/binary.txt', Buffer.from([0, 2, 3]));
  }

  public async lstat(filePath: string): Promise<WorkspaceGatewayStats> { const record = this.records.get(filePath); if (!record) throw missing(); return record.stats; }
  public async realpath(filePath: string): Promise<string> { if (!this.records.has(filePath)) throw missing(); return filePath; }
  public async readDirectory(directoryPath: string): Promise<readonly string[]> { const children = this.records.get(directoryPath)?.children; if (!children) throw missing(); return children; }
  public async openRead(filePath: string): Promise<WorkspaceGatewayFileHandle> {
    const content = this.records.get(filePath)?.content;
    if (!content) throw missing();
    let offset = 0;
    return {
      read: async (buffer, targetOffset, length) => { const amount = Math.min(length, content.length - offset); if (amount <= 0) return 0; content.copy(buffer, targetOffset, offset, offset + amount); offset += amount; return amount; },
      close: async () => undefined
    };
  }
  private directory(filePath: string, children: readonly string[]): void { this.records.set(filePath, { stats: stat({ directory: true }), children }); }
  private file(filePath: string, content: string | Buffer): void { const buffer = typeof content === 'string' ? Buffer.from(content) : content; this.records.set(filePath, { stats: stat({ file: true, size: buffer.length }), content: buffer }); }
}

function missing(): Error { return Object.assign(new Error('missing'), { code: 'ENOENT' }); }

class UserFixture implements IUserRepository {
  public async findActiveLocalUser(): Promise<LocalUserRecord> { return { id: 'user-1', displayName: 'Local user', passwordHash: 'stored-hash', isActive: true }; }
  public async findActiveLocalUserById(): Promise<LocalUserRecord> { return this.findActiveLocalUser(); }
  public async createLocalUser(_input: CreateLocalUserInput): Promise<LocalUserRecord> { throw new Error('not used'); }
}
class SessionFixture implements ISessionRepository {
  private readonly records = new Map<string, SessionRecord>();
  public async create(input: CreateSessionInput): Promise<Pick<SessionRecord, 'id' | 'userId' | 'expiresAt'>> { this.records.set(input.tokenHash, { id: 'session-1', userId: input.userId, displayName: 'Local user', expiresAt: input.expiresAt, revokedAt: null }); return { id: 'session-1', userId: input.userId, expiresAt: input.expiresAt }; }
  public async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> { return this.records.get(tokenHash) ?? null; }
  public async revoke(sessionId: string): Promise<void> { for (const [key, value] of this.records) if (value.id === sessionId) this.records.set(key, { ...value, revokedAt: NOW }); }
}
class TokenFixture implements IOpaqueTokenProvider { public createToken(): string { return RAW_TOKEN; } public digestToken(token: string): string { return `hash:${token}`; } public createCsrfToken(token: string): string { return `csrf:${token}`; } }
class ClockFixture implements IClock { public now(): Date { return NOW; } }
class PasswordFixture implements IPasswordHasher { public async hash(password: string): Promise<string> { return `hash:${password}`; } public async verify(password: string): Promise<boolean> { return password === 'correct-password'; } }
class RateFixture implements ILoginRateLimiter { public consume(): boolean { return true; } }

function buildApp(boundary: BoundaryFixture): express.Express {
  const sessions = new SessionFixture();
  const token = new TokenFixture();
  const clock = new ClockFixture();
  const getSession = new GetSessionUseCase(sessions, token, clock);
  const projects = new ProjectFixture();
  const gateway = new WorkspaceGatewayAdapter({ containerRoot: '/workspace', workspaceBoundary: boundary, fileSystem: new FileSystemFixture() });
  return createApp({
    logger: createLogger('silent'), readiness: new GetReadinessUseCase(new InMemoryReadinessState()), appVersion: 'test',
    auth: { login: new LoginUseCase(new UserFixture(), sessions, new PasswordFixture(), token, clock, { sessionLifetimeMs: 60_000 }), getSession, logout: new LogoutUseCase(sessions), appOrigin: APP_ORIGIN, cookieSecure: true, sessionLifetimeMs: 60_000, rateLimiter: new RateFixture() },
    workspace: { getSession, listWorkspaceFiles: new ListWorkspaceFilesUseCase(projects, gateway), treeWorkspaceFiles: new TreeWorkspaceFilesUseCase(projects, gateway), readWorkspaceText: new ReadWorkspaceTextUseCase(projects, gateway), searchWorkspaceText: new SearchWorkspaceTextUseCase(projects, gateway), clearSessionCookie: (response) => clearSessionCookie(response, true) }
  });
}

function cookiePair(response: request.Response): string { const cookies = response.headers['set-cookie']; const values = typeof cookies === 'string' ? [cookies] : cookies ?? []; const cookie = values.find((value) => value.startsWith('__Host-pa_session=')); if (!cookie) throw new Error('missing session'); return cookie.split(';')[0] ?? cookie; }

async function login(app: express.Express): Promise<{ readonly cookie: string; readonly csrf: string }> { const response = await request(app).post('/api/v1/auth/login').set('Origin', APP_ORIGIN).send({ password: 'correct-password' }).expect(200); return { cookie: cookiePair(response), csrf: response.body.data.csrfToken as string }; }

describe('workspace inspection API (integration)', () => {
  it('enforces authentication, project ownership, and relative path responses', async () => {
    const app = buildApp(new BoundaryFixture());
    await request(app).get(`/api/v1/projects/${PROJECT_ID}/files`).expect(401);
    const session = await login(app);
    await request(app).get(`/api/v1/projects/${PROJECT_ID}/files`).set('Cookie', session.cookie).expect(200).expect(({ body }) => {
      expect(body.data.entries.map((entry: { path: string }) => entry.path)).toEqual(['src']);
      expect(JSON.stringify(body)).not.toContain('/workspace');
    });
    await request(app).get(`/api/v1/projects/${OTHER_PROJECT_ID}/files`).set('Cookie', session.cookie).expect(404);
  });

  it('bounds tree/read/search and maps unsafe content to typed redacted errors', async () => {
    const app = buildApp(new BoundaryFixture());
    const session = await login(app);
    await request(app).get(`/api/v1/projects/${PROJECT_ID}/files/tree?depth=0`).set('Cookie', session.cookie).expect(200).expect(({ body }) => expect(body.data.entries[0]).toMatchObject({ path: 'src', type: 'directory' }));
    await request(app).get(`/api/v1/projects/${PROJECT_ID}/files/content?path=src%2Fmain.ts`).set('Cookie', session.cookie).expect(200).expect(({ body }) => expect(body.data.content).toContain('世界'));
    await request(app).get(`/api/v1/projects/${PROJECT_ID}/files/search?query=hello`).set('Cookie', session.cookie).expect(200).expect(({ body }) => expect(body.data.matches[0]).toMatchObject({ path: 'src/main.ts', line: 1 }));
    await request(app).get(`/api/v1/projects/${PROJECT_ID}/files/content?path=..%2Foutside.ts`).set('Cookie', session.cookie).expect(400).expect(({ body }) => expect(body.error.code).toBe('WORKSPACE_PATH_INVALID'));
    await request(app).get(`/api/v1/projects/${PROJECT_ID}/files/content?path=.env`).set('Cookie', session.cookie).expect(403).expect(({ body }) => { expect(body.error.code).toBe('WORKSPACE_PATH_FORBIDDEN'); expect(JSON.stringify(body)).not.toContain('PASSWORD'); });
    await request(app).get(`/api/v1/projects/${PROJECT_ID}/files/content?path=binary.txt`).set('Cookie', session.cookie).expect(415).expect(({ body }) => expect(body.error.code).toBe('WORKSPACE_FILE_BINARY'));
  });

  it('fails closed after a host identity mismatch', async () => {
    const boundary = new BoundaryFixture();
    const app = buildApp(boundary);
    const session = await login(app);
    boundary.available = false;
    await request(app).get(`/api/v1/projects/${PROJECT_ID}/files`).set('Cookie', session.cookie).expect(503).expect(({ body }) => expect(body.error.code).toBe('WORKSPACE_BOUNDARY_UNAVAILABLE'));
  });
});
