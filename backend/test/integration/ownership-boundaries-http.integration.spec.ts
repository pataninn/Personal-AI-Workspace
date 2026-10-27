import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';

import { createApp } from '@/app';
import { InMemoryAiRunRepository } from '@/infrastructure/ai-runs/in-memory-ai-run-repository';
import { InMemoryRunEventPublisher } from '@/infrastructure/ai-runs/in-memory-run-event-publisher';
import { FakeAgentRuntime } from '@/infrastructure/sandbox/fake-agent-runtime';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { WorkspaceGatewayAdapter } from '@/infrastructure/workspace/workspace-gateway';
import { clearSessionCookie } from '@/modules/auth';
import type { LocalUserRecord, SessionRecord } from '@/modules/auth/domain/auth-types';
import type { IClock, IOpaqueTokenProvider } from '@/modules/auth/repositories/security-providers';
import type { ISessionRepository } from '@/modules/auth/repositories/session-repository';
import type { IUserRepository } from '@/modules/auth/repositories/user-repository';
import { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { PrincipalAuthorization } from '@/modules/auth/use-cases/principal-authorization';
import type { AiRun, CreateAiRunRecord, EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { IConversationRepository } from '@/modules/conversations/repositories/conversation-repository';
import { ListWorkspaceFilesUseCase, ReadWorkspaceTextUseCase, SearchWorkspaceTextUseCase, TreeWorkspaceFilesUseCase } from '@/modules/files/use-cases';
import type { Project } from '@/modules/projects/domain/project-types';
import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { CreateProjectRecord, IProjectRepository, UpdateProjectStatusRecord } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceBoundary, ManagedProjectRootAllocation, ProjectRootScope, ResolvedProjectRoot, WorkspaceBoundarySnapshot } from '@/modules/projects/repositories/workspace-boundary';
import { CreateProjectUseCase, GetProjectUseCase, ListProjectsUseCase, UpdateProjectStatusUseCase } from '@/modules/projects/use-cases/project-use-cases';
import type { IWorkspacePlanningUseCases } from '@/modules/projects/use-cases/workspace-planning-use-cases';
import { GetAiRunUseCase } from '@/modules/ai-runs/use-cases/ai-run-use-cases';
import { CancelAiRunUseCase } from '@/modules/ai-runs/use-cases/cancel-ai-run-use-case';
import { StartAiRunUseCase } from '@/modules/ai-runs/use-cases/start-ai-run-use-case';
import type { ProjectTask, ProjectTaskFilter } from '@/modules/tasks/domain/project-task';
import { ProjectTaskNotFoundError, ProjectTaskVersionConflictError } from '@/modules/tasks/domain/project-task-errors';
import type { CreateProjectTaskRecord, IProjectTaskRepository, UpdateProjectTaskRecord } from '@/modules/tasks/repositories/project-task-repository';
import { CreateProjectTaskUseCase, ListProjectTaskSuggestionsUseCase, ListProjectTasksUseCase, ReorderProjectTaskUseCase, ResolveProjectTaskSuggestionUseCase, UpdateProjectTaskUseCase } from '@/modules/tasks/use-cases/project-task-use-cases';
import { GetReadinessUseCase } from '@/modules/health';
import { createLogger } from '@/shared/logging/logger';

const APP_ORIGIN = 'https://127.0.0.1:8443';
const OWNER_A = 'aa000000-0000-4000-8000-000000000001';
const OWNER_B = 'aa000000-0000-4000-8000-000000000002';
const PROJECT_A = 'aa010000-0000-4000-8000-000000000001';
const PROJECT_B = 'aa010000-0000-4000-8000-000000000002';
const MISSING_PROJECT = 'aa010000-0000-4000-8000-000000000099';
const TASK_A = 'aa020000-0000-4000-8000-000000000001';
const TASK_B = 'aa020000-0000-4000-8000-000000000002';
const MISSING_TASK = 'aa020000-0000-4000-8000-000000000099';
const TOKEN_A = 'owner-a-session-token-for-http-ownership-123456789';
const TOKEN_B = 'owner-b-session-token-for-http-ownership-123456789';
const NOW = new Date('2026-10-19T00:00:00.000Z');
const FOREIGN_PROJECT_MARKER = 'OWNER_B_PRIVATE_PROJECT_MARKER_7c29';
const FOREIGN_FILE_MARKER = 'OWNER_B_PRIVATE_FILE_MARKER_91fe';
const FOREIGN_TASK_MARKER = 'OWNER_B_PRIVATE_TASK_MARKER_2af8';

class TestClock implements IClock {
  public now(): Date { return NOW; }
}

class TestTokenProvider implements IOpaqueTokenProvider {
  public createToken(): string { return randomUUID(); }
  public digestToken(token: string): string { return createHash('sha256').update(token, 'utf8').digest('hex'); }
  public createCsrfToken(token: string): string { return `csrf:${token}`; }
}

class TestSessionRepository implements ISessionRepository {
  private readonly sessions = new Map<string, SessionRecord>();

  public constructor(tokenProvider: IOpaqueTokenProvider) {
    for (const [token, userId, displayName, role] of [
      [TOKEN_A, OWNER_A, 'Owner A admin', 'admin'],
      [TOKEN_B, OWNER_B, 'Owner B user', 'user']
    ] as const) {
      this.sessions.set(tokenProvider.digestToken(token), {
        id: `session:${userId}`,
        userId,
        displayName,
        accountKind: 'regular',
        role,
        accountExpiresAt: null,
        expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
        revokedAt: null
      });
    }
  }

  public async create(): Promise<never> { throw new Error('Sessions are pre-seeded in this fixture.'); }

  public async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> { return this.sessions.get(tokenHash) ?? null; }
  public async revoke(sessionId: string): Promise<void> {
    for (const [hash, record] of this.sessions) {
      if (record.id === sessionId) this.sessions.set(hash, { ...record, revokedAt: NOW });
    }
  }
}

class TestUserRepository implements IUserRepository {
  private readonly records = new Map<string, LocalUserRecord>([
    [OWNER_A, { id: OWNER_A, displayName: 'Owner A admin', identifier: 'owner-a', accountKind: 'regular', role: 'admin', passwordHash: 'unused', isActive: true, expiresAt: null }],
    [OWNER_B, { id: OWNER_B, displayName: 'Owner B user', identifier: 'owner-b', accountKind: 'regular', role: 'user', passwordHash: 'unused', isActive: true, expiresAt: null }]
  ]);

  public async findByIdentifier(identifier: string): Promise<LocalUserRecord | null> { return [...this.records.values()].find((record) => record.identifier === identifier) ?? null; }
  public async findById(userId: string): Promise<LocalUserRecord | null> { return this.records.get(userId) ?? null; }
  public async findBootstrapOwnerId(): Promise<string | null> { return OWNER_A; }
  public async hasAnyRegularAccounts(): Promise<boolean> { return true; }
  public async createRegularAccount(): Promise<never> { throw new Error('Account creation is not part of this fixture.'); }
  public async bootstrapInitialAdmin(): Promise<boolean> { return false; }
  public async disableAccount(): Promise<'disabled'> { return 'disabled'; }
}

function users(): TestUserRepository { return new TestUserRepository(); }

class TestProjectRepository implements IProjectRepository {
  private readonly records = new Map<string, Project>();

  public constructor() {
    this.records.set(PROJECT_A, makeProject(OWNER_A, PROJECT_A, 'Owner A project'));
    this.records.set(PROJECT_B, makeProject(OWNER_B, PROJECT_B, `Owner B ${FOREIGN_PROJECT_MARKER}`));
  }

  public async listByOwner(ownerId: string, includeArchived: boolean): Promise<readonly Project[]> {
    return [...this.records.values()].filter((project) => project.ownerId === ownerId && (includeArchived || project.status === 'active'));
  }
  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> {
    const project = this.records.get(projectId);
    return project?.ownerId === ownerId ? project : null;
  }
  public async listActiveRoots(ownerId: string): Promise<readonly string[]> {
    return [...this.records.values()]
      .filter((project) => project.ownerId === ownerId && project.status === 'active')
      .flatMap((project) => project.relativeRoot === null ? [] : [project.relativeRoot]);
  }
  public async create(input: CreateProjectRecord): Promise<Project> {
    const project: Project = { ...input, status: 'active', version: 1, createdAt: NOW, updatedAt: NOW };
    this.records.set(project.id, project);
    return project;
  }
  public async recoverUncreatedRoot(ownerId: string, projectId: string, discard: () => Promise<void>): Promise<void> {
    if (!await this.findByIdForOwner(ownerId, projectId)) await discard();
  }
  public async updateStatus(input: UpdateProjectStatusRecord): Promise<Project | null> {
    const current = await this.findByIdForOwner(input.ownerId, input.projectId);
    if (!current || current.version !== input.expectedVersion) return null;
    const updated = { ...current, status: input.status, version: current.version + 1, updatedAt: new Date(NOW.getTime() + 1) };
    this.records.set(updated.id, updated);
    return updated;
  }
}

class TempManagedWorkspaceBoundary implements IWorkspaceBoundary {
  public constructor(private readonly managedRoot: string) {}

  public async getSnapshot(): Promise<WorkspaceBoundarySnapshot> { return { status: 'ready' }; }
  public async getManagedSnapshot(): Promise<WorkspaceBoundarySnapshot> { return { status: 'ready' }; }
  public async assertReady(): Promise<void> { return undefined; }
  public async validateProjectRoot(relativeRoot: string): Promise<string> { return relativeRoot; }
  public async createManagedProjectRoot(_ownerId: string, projectId: string): Promise<string> { return `projects/${projectId}`; }
  public async allocateManagedProjectRoot(ownerId: string, projectId: string): Promise<ManagedProjectRootAllocation> {
    return { relativeRoot: await this.createManagedProjectRoot(ownerId, projectId), discardIfEmpty: async () => undefined };
  }
  public async resolveProjectRoot(scope: ProjectRootScope): Promise<ResolvedProjectRoot> {
    if (scope.storageKind !== 'managed' || scope.relativeRoot !== `projects/${scope.projectId}`) {
      throw new Error('The test workspace received an unexpected persisted project scope.');
    }
    return {
      canonicalRoot: this.managedRoot,
      canonicalProjectRoot: path.join(this.managedRoot, scope.ownerId, 'projects', scope.projectId)
    };
  }
}

class TestProjectTaskRepository implements IProjectTaskRepository {
  private readonly records: { readonly ownerId: string; readonly task: ProjectTask }[] = [];

  public seed(ownerId: string, task: ProjectTask): void { this.records.push({ ownerId, task }); }

  public async listTasks(ownerId: string, projectId: string, filter: ProjectTaskFilter) {
    const tasks = this.records
      .filter(({ ownerId: recordOwner, task }) => recordOwner === ownerId && task.projectId === projectId && matchesFilter(task, filter))
      .map(({ task }) => task)
      .sort((left, right) => left.position - right.position);
    return { tasks, orderVersion: 1 };
  }

  public async createTask(_input: CreateProjectTaskRecord): Promise<never> { throw new Error('Task creation is not part of this fixture.'); }

  public async updateTask(input: UpdateProjectTaskRecord): Promise<{ readonly task: ProjectTask; readonly orderVersion: number }> {
    const index = this.records.findIndex(({ ownerId, task }) => ownerId === input.ownerId && task.projectId === input.projectId && task.id === input.taskId);
    const current = this.records[index]?.task;
    if (!current) throw new ProjectTaskNotFoundError();
    if (current.version !== input.expectedVersion) throw new ProjectTaskVersionConflictError();
    const status = input.status ?? current.status;
    const updated: ProjectTask = {
      ...current,
      ...input.text,
      status,
      version: current.version + 1,
      updatedAt: new Date(NOW.getTime() + 2),
      completedAt: status === 'done' ? new Date(NOW.getTime() + 2) : status === 'todo' || status === 'in_progress' || status === 'blocked' ? null : current.completedAt
    };
    this.records[index] = { ownerId: input.ownerId, task: updated };
    return { task: updated, orderVersion: 1 };
  }

  public async reorderTask(): Promise<never> { throw new ProjectTaskNotFoundError(); }
  public async listSuggestions(): Promise<readonly []> { return []; }
  public async resolveSuggestion(): Promise<never> { throw new ProjectTaskNotFoundError(); }
}

let app: express.Express;
let rootDirectory: string;
let projects: TestProjectRepository;
let tasks: TestProjectTaskRepository;
let runs: InMemoryAiRunRepository;
let runForA: AiRun;
let runForB: AiRun;

beforeAll(async () => {
  rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-2-2-ownership-http-'));
  const managedRoot = path.join(rootDirectory, 'managed');
  await fs.mkdir(managedRoot, { recursive: true });
  await seedProjectFiles(managedRoot, OWNER_A, PROJECT_A, 'owner-a-private.md', 'OWNER_A_PRIVATE_FILE_MARKER_72d1');
  await seedProjectFiles(managedRoot, OWNER_B, PROJECT_B, 'owner-b-private.md', FOREIGN_FILE_MARKER);

  const boundary = new TempManagedWorkspaceBoundary(managedRoot);
  projects = new TestProjectRepository();
  const workspace = new WorkspaceGatewayAdapter({ containerRoot: '/workspace', workspaceBoundary: boundary });
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  const tokenProvider = new TestTokenProvider();
  const sessions = new TestSessionRepository(tokenProvider);
  const getSession = new GetSessionUseCase(sessions, tokenProvider, new TestClock());
  const userRepository = users();
  const taskRepository = new TestProjectTaskRepository();
  tasks = taskRepository;
  taskRepository.seed(OWNER_A, makeTask(TASK_A, PROJECT_A, 'Owner A task'));
  taskRepository.seed(OWNER_B, makeTask(TASK_B, PROJECT_B, `Owner B ${FOREIGN_TASK_MARKER}`));

  runs = new InMemoryAiRunRepository();
  const runEvents = new InMemoryRunEventPublisher();
  runForA = await createCompletedRun(runs, OWNER_A, PROJECT_A);
  runForB = await createCompletedRun(runs, OWNER_B, PROJECT_B);
  const runtime = new FakeAgentRuntime();
  const conversationRepository: IConversationRepository = {
    listByProjectForOwner: async () => ({ conversations: [], nextCursor: null }),
    findWithMessagesForOwner: async () => null,
    create: async () => { throw new Error('Conversation creation is not part of this fixture.'); },
    addUserMessage: async () => { throw new Error('Conversation messages are not part of this fixture.'); }
  };

  const workspacePlanning: IWorkspacePlanningUseCases = {
    search: async (input) => ({ projects: [], limit: input.limit, hasMore: false }),
    reuse: async () => { throw new ProjectNotFoundError(); },
    createPlanning: async () => { throw new Error('Planning creation is not part of this fixture.'); },
    updateObjective: async () => { throw new Error('Objective updates are not part of this fixture.'); },
    attachInitialRoot: async () => { throw new Error('Root attachment is not part of this fixture.'); }
  };

  app = createApp({
    logger: createLogger('silent'),
    readiness: new GetReadinessUseCase(readiness),
    appVersion: 'ownership-http-test',
    projects: {
      getSession,
      createProject: new CreateProjectUseCase(projects, boundary),
      listProjects: new ListProjectsUseCase(projects),
      getProject: new GetProjectUseCase(projects),
      updateProjectStatus: new UpdateProjectStatusUseCase(projects, boundary),
      workspacePlanning,
      workspaceBoundary: boundary,
      appOrigin: APP_ORIGIN,
      clearSessionCookie: (response) => clearSessionCookie(response, true)
    },
    workspace: {
      getSession,
      listWorkspaceFiles: new ListWorkspaceFilesUseCase(projects, workspace),
      treeWorkspaceFiles: new TreeWorkspaceFilesUseCase(projects, workspace),
      readWorkspaceText: new ReadWorkspaceTextUseCase(projects, workspace),
      searchWorkspaceText: new SearchWorkspaceTextUseCase(projects, workspace),
      appOrigin: APP_ORIGIN,
      clearSessionCookie: (response) => clearSessionCookie(response, true)
    },
    projectTasks: {
      getSession,
      listTasks: new ListProjectTasksUseCase(projects, taskRepository),
      createTask: new CreateProjectTaskUseCase(projects, taskRepository),
      updateTask: new UpdateProjectTaskUseCase(projects, taskRepository),
      reorderTask: new ReorderProjectTaskUseCase(projects, taskRepository),
      listSuggestions: new ListProjectTaskSuggestionsUseCase(projects, taskRepository),
      resolveSuggestion: new ResolveProjectTaskSuggestionUseCase(projects, taskRepository),
      appOrigin: APP_ORIGIN,
      clearSessionCookie: (response) => clearSessionCookie(response, true)
    },
    aiRunChat: {
      getSession,
      principalAuthorization: new PrincipalAuthorization(userRepository, new TestClock()),
      getAiRun: new GetAiRunUseCase(runs, projects),
      startAiRun: new StartAiRunUseCase(runs, conversationRepository, runtime, runEvents, { admitDemoRunStart: async () => undefined }),
      cancelAiRun: new CancelAiRunUseCase(runs, runtime, runEvents),
      events: runEvents,
      appOrigin: APP_ORIGIN,
      clearSessionCookie: (response) => clearSessionCookie(response, true)
    }
  });
}, 30_000);

afterAll(async () => {
  if (rootDirectory) await fs.rm(rootDirectory, { recursive: true, force: true });
});

describe('Task 2.2 HTTP ownership boundaries', () => {
  it('allows each principal to read only its own project and managed files, including for an admin', async () => {
    const ownerAProject = await request(app).get(`/api/v1/projects/${PROJECT_A}`).set(cookie(TOKEN_A)).expect(200);
    expect(ownerAProject.body.data).toMatchObject({ id: PROJECT_A, name: 'Owner A project', capabilities: { planning: true, fileAccess: true } });
    expect(JSON.stringify(ownerAProject.body)).not.toContain(FOREIGN_PROJECT_MARKER);

    const ownerBProject = await request(app).get(`/api/v1/projects/${PROJECT_B}`).set(cookie(TOKEN_B)).expect(200);
    expect(ownerBProject.body.data).toMatchObject({ id: PROJECT_B, name: `Owner B ${FOREIGN_PROJECT_MARKER}` });

    const ownerAFile = await request(app).get(`/api/v1/projects/${PROJECT_A}/files/content`).query({ path: 'owner-a-private.md' }).set(cookie(TOKEN_A)).expect(200);
    expect(ownerAFile.body.data.content).toContain('OWNER_A_PRIVATE_FILE_MARKER_72d1');
    const ownerBFile = await request(app).get(`/api/v1/projects/${PROJECT_B}/files/content`).query({ path: 'owner-b-private.md' }).set(cookie(TOKEN_B)).expect(200);
    expect(ownerBFile.body.data.content).toContain(FOREIGN_FILE_MARKER);

    const foreignProject = await request(app).get(`/api/v1/projects/${PROJECT_B}`).set(cookie(TOKEN_A)).expect(404);
    const missingProject = await request(app).get(`/api/v1/projects/${MISSING_PROJECT}`).set(cookie(TOKEN_A)).expect(404);
    expect(foreignProject.body.error).toEqual(missingProject.body.error);
    expect(JSON.stringify(foreignProject.body)).not.toContain(FOREIGN_PROJECT_MARKER);

    const foreignFile = await request(app).get(`/api/v1/projects/${PROJECT_B}/files/content`).query({ path: 'owner-b-private.md' }).set(cookie(TOKEN_A)).expect(404);
    const missingFileProject = await request(app).get(`/api/v1/projects/${MISSING_PROJECT}/files/content`).query({ path: 'owner-b-private.md' }).set(cookie(TOKEN_A)).expect(404);
    expect(foreignFile.body.error).toEqual(missingFileProject.body.error);
    expect(JSON.stringify(foreignFile.body)).not.toContain(FOREIGN_FILE_MARKER);

    const foreignFileName = await request(app).get(`/api/v1/projects/${PROJECT_A}/files/content`).query({ path: 'owner-b-private.md' }).set(cookie(TOKEN_A)).expect(404);
    expect(foreignFileName.body.error.code).toBe('WORKSPACE_PATH_NOT_FOUND');
    expect(JSON.stringify(foreignFileName.body)).not.toContain(FOREIGN_FILE_MARKER);

    const reverseForeignProject = await request(app).get(`/api/v1/projects/${PROJECT_A}`).set(cookie(TOKEN_B)).expect(404);
    const reverseMissingProject = await request(app).get(`/api/v1/projects/${MISSING_PROJECT}`).set(cookie(TOKEN_B)).expect(404);
    expect(reverseForeignProject.body.error).toEqual(reverseMissingProject.body.error);

    const reverseForeignFile = await request(app).get(`/api/v1/projects/${PROJECT_A}/files/content`).query({ path: 'owner-a-private.md' }).set(cookie(TOKEN_B)).expect(404);
    const reverseMissingFileProject = await request(app).get(`/api/v1/projects/${MISSING_PROJECT}/files/content`).query({ path: 'owner-a-private.md' }).set(cookie(TOKEN_B)).expect(404);
    expect(reverseForeignFile.body.error).toEqual(reverseMissingFileProject.body.error);
    expect(JSON.stringify(reverseForeignFile.body)).not.toContain('OWNER_A_PRIVATE_FILE_MARKER_72d1');
  });

  it('keeps project task lists and task IDs scoped to both owner and project', async () => {
    const ownerATasks = await request(app).get(`/api/v1/projects/${PROJECT_A}/tasks`).set(cookie(TOKEN_A)).expect(200);
    expect(ownerATasks.body.data.tasks.map((task: ProjectTask) => task.id)).toEqual([TASK_A]);
    const ownerBTasks = await request(app).get(`/api/v1/projects/${PROJECT_B}/tasks`).set(cookie(TOKEN_B)).expect(200);
    expect(ownerBTasks.body.data.tasks.map((task: ProjectTask) => task.id)).toEqual([TASK_B]);
    expect(JSON.stringify(ownerBTasks.body)).toContain(FOREIGN_TASK_MARKER);

    const updatedOwnTask = await request(app)
      .patch(`/api/v1/projects/${PROJECT_B}/tasks/${TASK_B}`)
      .set({ ...cookie(TOKEN_B), Origin: APP_ORIGIN, 'X-CSRF-Token': csrf(TOKEN_B), 'If-Match': '"1"' })
      .send({ status: 'done' })
      .expect(200);
    expect(updatedOwnTask.body.data.task).toMatchObject({ id: TASK_B, status: 'done' });

    const foreignTask = await request(app)
      .patch(`/api/v1/projects/${PROJECT_A}/tasks/${TASK_B}`)
      .set({ ...cookie(TOKEN_A), Origin: APP_ORIGIN, 'X-CSRF-Token': csrf(TOKEN_A), 'If-Match': '"1"' })
      .send({ status: 'done' })
      .expect(404);
    const missingTask = await request(app)
      .patch(`/api/v1/projects/${PROJECT_A}/tasks/${MISSING_TASK}`)
      .set({ ...cookie(TOKEN_A), Origin: APP_ORIGIN, 'X-CSRF-Token': csrf(TOKEN_A), 'If-Match': '"1"' })
      .send({ status: 'done' })
      .expect(404);
    expect(foreignTask.body.error).toEqual(missingTask.body.error);
    expect(JSON.stringify(foreignTask.body)).not.toContain(FOREIGN_TASK_MARKER);

    const reverseForeignTask = await request(app)
      .patch(`/api/v1/projects/${PROJECT_B}/tasks/${TASK_A}`)
      .set({ ...cookie(TOKEN_B), Origin: APP_ORIGIN, 'X-CSRF-Token': csrf(TOKEN_B), 'If-Match': '"1"' })
      .send({ status: 'done' })
      .expect(404);
    const reverseMissingTask = await request(app)
      .patch(`/api/v1/projects/${PROJECT_B}/tasks/${MISSING_TASK}`)
      .set({ ...cookie(TOKEN_B), Origin: APP_ORIGIN, 'X-CSRF-Token': csrf(TOKEN_B), 'If-Match': '"1"' })
      .send({ status: 'done' })
      .expect(404);
    expect(reverseForeignTask.body.error).toEqual(reverseMissingTask.body.error);
    expect(JSON.stringify(reverseForeignTask.body)).not.toContain('Owner A task');

    const foreignProjectTasks = await request(app).get(`/api/v1/projects/${PROJECT_B}/tasks`).set(cookie(TOKEN_A)).expect(404);
    const missingProjectTasks = await request(app).get(`/api/v1/projects/${MISSING_PROJECT}/tasks`).set(cookie(TOKEN_A)).expect(404);
    expect(foreignProjectTasks.body.error).toEqual(missingProjectTasks.body.error);
    expect(JSON.stringify(foreignProjectTasks.body)).not.toContain(FOREIGN_TASK_MARKER);
  });

  it('streams events for each owned persisted run and hides a foreign run as missing', async () => {
    const ownerAEvents = await request(app)
      .get(`/api/v1/ai-runs/${runForA.id}/events`)
      .set(cookie(TOKEN_A))
      .buffer(true)
      .parse((response, callback) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => callback(null, body));
      })
      .expect(200);
    expect(ownerAEvents.body).toContain('event: run.snapshot');
    expect(ownerAEvents.body).toContain(runForA.id);
    expect(ownerAEvents.body).not.toContain(runForB.id);

    const ownerBEvents = await request(app)
      .get(`/api/v1/ai-runs/${runForB.id}/events`)
      .set(cookie(TOKEN_B))
      .buffer(true)
      .parse((response, callback) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => callback(null, body));
      })
      .expect(200);
    expect(ownerBEvents.body).toContain('event: run.snapshot');
    expect(ownerBEvents.body).toContain(runForB.id);

    const foreignEvents = await request(app).get(`/api/v1/ai-runs/${runForB.id}/events`).set(cookie(TOKEN_A)).expect(404);
    const missingEvents = await request(app).get('/api/v1/ai-runs/aa030000-0000-4000-8000-000000000099/events').set(cookie(TOKEN_A)).expect(404);
    expect(foreignEvents.body.error).toEqual(missingEvents.body.error);
    expect(JSON.stringify(foreignEvents.body)).not.toContain(runForB.id);

    const reverseForeignEvents = await request(app).get(`/api/v1/ai-runs/${runForA.id}/events`).set(cookie(TOKEN_B)).expect(404);
    const reverseMissingEvents = await request(app).get('/api/v1/ai-runs/aa030000-0000-4000-8000-000000000099/events').set(cookie(TOKEN_B)).expect(404);
    expect(reverseForeignEvents.body.error).toEqual(reverseMissingEvents.body.error);
    expect(JSON.stringify(reverseForeignEvents.body)).not.toContain(runForA.id);
  });
});

function makeProject(ownerId: string, id: string, name: string): Project {
  return {
    id, ownerId, name, slug: name.toLocaleLowerCase('en-US').replaceAll(' ', '-'),
    relativeRoot: `projects/${id}`, storageKind: 'managed', objective: null, status: 'active', version: 1, createdAt: NOW, updatedAt: NOW
  };
}

function makeTask(id: string, projectId: string, title: string): ProjectTask {
  return {
    id, projectId, title, details: title.includes(FOREIGN_TASK_MARKER) ? FOREIGN_TASK_MARKER : null,
    status: 'todo', importance: 'medium', deadline: null, subtasks: [], position: 1, version: 1,
    source: { kind: 'user', label: 'Added by you', suggestionId: null, runId: null, conversationId: null, acceptedAt: null },
    createdAt: NOW, updatedAt: NOW, completedAt: null
  };
}

function matchesFilter(task: ProjectTask, filter: ProjectTaskFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'open') return task.status !== 'done';
  if (filter === 'completed') return task.status === 'done';
  return false;
}

function cookie(token: string): { Cookie: string } { return { Cookie: `__Host-pa_session=${token}` }; }
function csrf(token: string): string { return `csrf:${token}`; }

async function seedProjectFiles(root: string, ownerId: string, projectId: string, fileName: string, content: string): Promise<void> {
  const projectRoot = path.join(root, ownerId, 'projects', projectId);
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, fileName), content, 'utf8');
}

async function createCompletedRun(repository: InMemoryAiRunRepository, ownerId: string, projectId: string): Promise<AiRun> {
  const manifest: EgressManifest = {
    manifestHash: 'a'.repeat(64), provider: 'NVIDIA hosted NIM', providerProfile: 'nvidia-hosted-nim', model: 'test-model',
    categories: ['Request'], files: [], requestBytes: 12, messageBytes: 0, messageCount: 0,
    messageHash: 'b'.repeat(64), byteEstimate: 12, tokenEstimate: 3, excludedItemCount: 0, omittedItemCount: 0,
    omissionSummary: 'No items omitted.', bestEffortSecretDetection: true
  };
  const created = await repository.create({
    ownerId, projectId, conversationId: randomUUID(), request: 'Inspect a synthetic project',
    relativeRoot: `projects/${projectId}`, storageKind: 'managed', requestedPaths: [], manifest,
    idempotencyKey: `create-${ownerId}`, requestFingerprint: `fingerprint-${ownerId}`
  } satisfies CreateAiRunRecord);
  const completed: AiRun = {
    ...created.resource, status: 'succeeded', phase: 'terminal', decision: 'approved', runtimeKind: 'fake',
    sandboxReady: true, cleanup: 'complete', safeMessage: 'Synthetic run complete.', updatedAt: NOW
  };
  await repository.save(completed);
  return completed;
}
