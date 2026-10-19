import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import request from 'supertest';
import type { DataSource } from 'typeorm';

import { createApp } from '@/app';
import { createDataSource } from '@/infrastructure/database/data-source';
import { TypeOrmActionLedgerRepository } from '@/infrastructure/database/repositories/typeorm-action-ledger-repository';
import { TypeOrmHomeActionEventRecorder } from '@/infrastructure/database/repositories/typeorm-home-action-event-recorder';
import { TypeOrmHomeChangeProposalRepository } from '@/infrastructure/database/repositories/typeorm-home-change-proposal-repository';
import { TypeOrmHomeConversationRepository } from '@/infrastructure/database/repositories/typeorm-home-conversation-repository';
import { TypeOrmProjectRepository } from '@/infrastructure/database/repositories/typeorm-project-repository';
import { TypeOrmProjectTaskRepository } from '@/infrastructure/database/repositories/typeorm-project-task-repository';
import { TypeOrmStorageQuotaRepository } from '@/infrastructure/database/repositories/typeorm-storage-quota-repository';
import { TypeOrmStorageRootMappingRepository } from '@/infrastructure/database/repositories/typeorm-storage-root-mapping-repository';
import { TypeOrmStorageContentAccounting } from '@/infrastructure/database/storage-content-accounting';
import { WorkspaceGatewayAdapter } from '@/infrastructure/workspace/workspace-gateway';
import { StorageQuotaRootScanner, type TrustedStorageRoot } from '@/infrastructure/workspace/storage-quota-reconciliation';
import { ActionUndoUseCases } from '@/modules/home-assistant/use-cases/action-undo-use-cases';
import { CancelHomeTurnUseCase } from '@/modules/home-assistant/use-cases/cancel-home-turn';
import { CreateHomeConversationUseCase } from '@/modules/home-assistant/use-cases/create-home-conversation';
import { DecideHomeConsentUseCase } from '@/modules/home-assistant/use-cases/decide-home-consent';
import { GetHomeConversationUseCase } from '@/modules/home-assistant/use-cases/get-home-conversation';
import { GetHomeTurnUseCase } from '@/modules/home-assistant/use-cases/get-home-turn';
import { HomeChangeProposalUseCases } from '@/modules/home-assistant/use-cases/home-change-proposal-use-cases';
import { HomePlanningToolRequestHandler } from '@/modules/home-assistant/use-cases/home-planning-tool-request-handler';
import { ListHomeConversationsUseCase } from '@/modules/home-assistant/use-cases/list-home-conversations';
import { ListHomeEventsUseCase } from '@/modules/home-assistant/use-cases/list-home-events';
import { ListHomeMessagesUseCase } from '@/modules/home-assistant/use-cases/list-home-messages';
import { ListHomeTurnsUseCase } from '@/modules/home-assistant/use-cases/list-home-turns';
import { SubmitHomeTurnUseCase } from '@/modules/home-assistant/use-cases/submit-home-turn';
import { ListConversationsUseCase, CreateConversationUseCase, GetConversationUseCase, AddUserMessageUseCase } from '@/modules/conversations/use-cases';
import { ListWorkspaceFilesUseCase, ReadWorkspaceTextUseCase, SearchWorkspaceTextUseCase, TreeWorkspaceFilesUseCase } from '@/modules/files/use-cases';
import type { IWorkspaceBoundary, ProjectRootScope, ResolvedProjectRoot } from '@/modules/projects/repositories/workspace-boundary';
import { WorkspacePlanningUseCases } from '@/modules/projects/use-cases/workspace-planning-use-cases';
import { GetReadinessUseCase } from '@/modules/health';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import { TypeOrmConversationRepository } from '@/infrastructure/database/repositories/typeorm-conversation-repository';
import { CountInboxTasksUseCase, GetGlobalTaskUseCase, ListGlobalTasksUseCase } from '@/modules/tasks/use-cases/global-task-query-use-cases';
import { TaskMutationUseCases } from '@/modules/tasks/use-cases/task-mutation-use-cases';
import { GetHomeConversationUseCase as GetConversationHistoryUseCase } from '@/modules/home-assistant/use-cases/get-home-conversation';
import { createLogger } from '@/shared/logging/logger';
import type { StorageResourceReference } from '@/modules/storage-quotas/domain/storage-quota-types';
import type { StorageRootMapping } from '@/modules/storage-quotas/repositories/storage-root-mapping-repository';

const OWNER_A = '4a105111-1111-4111-8111-111111111111';
const OWNER_B = '4a105222-2222-4222-8222-222222222222';
const WORKSPACE_ALPHA = '4a105a11-1111-4111-8111-111111111111';
const WORKSPACE_BETA = '4a105b22-2222-4222-8222-222222222222';
const WORKSPACE_ROOTLESS = '4a105c33-3333-4333-8333-333333333333';
const WORKSPACE_ARCHIVED = '4a105d44-4444-4444-8444-444444444444';
const WORKSPACE_DOT = '4a105e55-5555-4555-8555-555555555555';
const ORIGIN = 'https://127.0.0.1:8443';
const USER_A = '__Host-pa_session=r1-owner-a';
const USER_B = '__Host-pa_session=r1-owner-b';
const databaseUrl = process.env.HOME_CONVERSATION_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !new Set(['127.0.0.1', 'localhost', '::1', '[::1]']).has(target.hostname)
    || target.port !== '55441'
    || target.pathname !== '/home_history_test'
    || target.username !== 'home_test') {
    throw new Error('HOME_CONVERSATION_TEST_DATABASE_URL must target home_test/home_history_test on loopback port 55441.');
  }
}

interface WorkspaceIds {
  readonly alpha: string;
  readonly beta: string;
  readonly rootless: string;
  readonly archived: string;
  readonly dot: string;
}

interface TaskCreated {
  readonly id: string;
  readonly version: number;
  readonly receiptId: string;
}

interface ReleaseWorkspaceBoundary extends IWorkspaceBoundary {}

class FixtureWorkspaceBoundary implements ReleaseWorkspaceBoundary {
  public constructor(private readonly legacyRoot: string, private readonly managedRoot: string) {}

  public async getSnapshot(): Promise<{ readonly status: 'ready' }> { return { status: 'ready' }; }
  public async getManagedSnapshot(): Promise<{ readonly status: 'ready' }> { return { status: 'ready' }; }
  public async assertReady(): Promise<void> { return undefined; }
  public async validateProjectRoot(relativeRoot: string): Promise<string> { return relativeRoot; }
  public async inspectManagedNamespace() { return { configured: false, unattributableEntries: false, owners: [] }; }

  public async resolveProjectRoot(scope: ProjectRootScope): Promise<ResolvedProjectRoot> {
    if (scope.storageKind === 'legacy') {
      if (scope.ownerId !== OWNER_A) throw new Error('The legacy fixture is reserved for its bootstrap owner.');
      const canonicalRoot = path.resolve(this.legacyRoot);
      return {
        canonicalRoot,
        canonicalProjectRoot: scope.relativeRoot === '.' ? canonicalRoot : path.resolve(canonicalRoot, ...scope.relativeRoot.split('/'))
      };
    }
    if (scope.relativeRoot !== `projects/${scope.projectId}`) throw new Error('Managed fixture roots are server-derived.');
    const canonicalRoot = path.resolve(this.managedRoot);
    return { canonicalRoot, canonicalProjectRoot: path.resolve(canonicalRoot, scope.ownerId, 'projects', scope.projectId) };
  }
}

describeDatabase('R1 release HTTP and PostgreSQL regression', () => {
  const dataSource: DataSource = createDataSource({ url: databaseUrl ?? 'postgres://disabled:disabled@127.0.0.1:1/disabled' });
  let root: string;
  let managedRoot: string;
  let recoveryRoot: string;
  let app: ReturnType<typeof createApp>;
  let homeRepository: TypeOrmHomeConversationRepository;
  let planningHandler: HomePlanningToolRequestHandler;
  let workspaces: WorkspaceIds;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pai-r1-http-pg-'));
    managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pai-r1-managed-pg-'));
    recoveryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pai-r1-recovery-pg-'));
    await fs.mkdir(path.join(root, 'repo', 'alpha'), { recursive: true });
    await fs.mkdir(path.join(root, 'repo', 'beta'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), 'Root project fixture file.\n', 'utf8');
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    const migrations: readonly { readonly name: string }[] = await dataSource.query('SELECT "name" FROM "migrations"');
    expect(migrations).toHaveLength(dataSource.migrations.length);
    initializeApp();
  }, 120_000);

  beforeEach(async () => {
    await removeFixtureRootsAndMappings(dataSource, [OWNER_A, OWNER_B], managedRoot);
    await dataSource.query('DROP TRIGGER IF EXISTS "r1_reject_proposal_sentinel" ON "project_tasks"');
    await dataSource.query('DROP FUNCTION IF EXISTS "r1_reject_proposal_sentinel"()');
    await dataSource.query('DELETE FROM "home_change_proposals" WHERE "owner_id" = ANY($1::uuid[])', [[OWNER_A, OWNER_B]]);
    await dataSource.query('DELETE FROM "users" WHERE "id" = ANY($1::uuid[])', [[OWNER_A, OWNER_B]]);
    await dataSource.query(
      `INSERT INTO "users" ("id", "scope_key", "identifier", "display_name", "password_hash") VALUES
       ($1, 'r1-release-owner-a', 'r1-release-owner-a', 'R1 Fixture Owner A', 'x'),
       ($2, 'r1-release-owner-b', 'r1-release-owner-b', 'R1 Fixture Owner B', 'x')`,
      [OWNER_A, OWNER_B]
    );
    workspaces = {
      alpha: await createWorkspace(OWNER_A, WORKSPACE_ALPHA, 'release-alpha', 'repo/alpha', 'active'),
      beta: await createWorkspace(OWNER_A, WORKSPACE_BETA, 'release-beta', 'repo/beta', 'active'),
      rootless: await createWorkspace(OWNER_A, WORKSPACE_ROOTLESS, 'release-planning', null, 'active'),
      archived: await createWorkspace(OWNER_A, WORKSPACE_ARCHIVED, 'release-archive', 'archive', 'active'),
      dot: await createWorkspace(OWNER_B, WORKSPACE_DOT, 'release-dot-root', '.', 'active')
    };
    await reconcileReleaseOwners(
      dataSource,
      [OWNER_A, OWNER_B],
      new FixtureWorkspaceBoundary(root, managedRoot),
      recoveryRoot
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) {
      await removeFixtureRootsAndMappings(dataSource, [OWNER_A, OWNER_B], managedRoot);
      await dataSource.query('DROP TRIGGER IF EXISTS "r1_reject_proposal_sentinel" ON "project_tasks"');
      await dataSource.query('DROP FUNCTION IF EXISTS "r1_reject_proposal_sentinel"()');
      await dataSource.query('DELETE FROM "home_change_proposals" WHERE "owner_id" = ANY($1::uuid[])', [[OWNER_A, OWNER_B]]);
      await dataSource.query('DELETE FROM "users" WHERE "id" = ANY($1::uuid[])', [[OWNER_A, OWNER_B]]);
      await dataSource.destroy();
    }
    if (root) await fs.rm(root, { recursive: true, force: true });
    if (managedRoot) await fs.rm(managedRoot, { recursive: true, force: true });
    if (recoveryRoot) await fs.rm(recoveryRoot, { recursive: true, force: true });
  });

  it('captures, filters, moves, undoes, and reloads owner-scoped tasks through HTTP and PostgreSQL', async () => {
    const homeTurn = await createActiveHomeTurn('r1-manual-receipt-events');
    const inbox = await createTask(USER_A, 'R1 manual Inbox task', null, 'r1-manual-inbox');
    const alpha = await createTask(USER_A, 'R1 alpha task', workspaces.alpha, 'r1-alpha-task');
    const beta = await createTask(USER_A, 'R1 beta task', workspaces.beta, 'r1-beta-task');

    const all = await request(app).get('/api/v1/tasks?status=todo&limit=100').set({ Cookie: USER_A }).expect(200);
    const allItems = responseData<{ readonly items: readonly { readonly task: { readonly id: string }; readonly collection: string; readonly workspace: { readonly id: string } | null }[] }>(all).items;
    expect(allItems.map(({ task }) => task.id)).toEqual(expect.arrayContaining([inbox.id, alpha.id, beta.id]));
    expect(allItems.find(({ task }) => task.id === inbox.id)).toMatchObject({ collection: 'inbox', workspace: null });
    expect(allItems.find(({ task }) => task.id === alpha.id)).toMatchObject({ collection: 'workspace', workspace: { id: workspaces.alpha } });
    const filtered = await request(app).get(`/api/v1/tasks?workspaceId=${workspaces.beta}&importance=medium`).set({ Cookie: USER_A }).expect(200);
    expect(responseData<{ readonly items: readonly { readonly task: { readonly id: string } }[] }>(filtered).items.map(({ task }) => task.id)).toContain(beta.id);
    const inboxPage = await request(app).get('/api/v1/tasks?inboxOnly=true&limit=100').set({ Cookie: USER_A }).expect(200);
    expect(responseData<{ readonly items: readonly { readonly task: { readonly id: string } }[] }>(inboxPage).items.map(({ task }) => task.id)).toContain(inbox.id);

    const moved = await request(app).post(`/api/v1/tasks/${inbox.id}/move`)
      .set({ ...mutationHeaders(USER_A), 'Idempotency-Key': 'r1-move-inbox', 'If-Match': `"${inbox.version}"` })
      .send({ workspaceId: workspaces.alpha }).expect(200);
    const movedData = responseData<{ readonly item: { readonly task: { readonly id: string; readonly projectId: string } }; readonly receipt: { readonly id: string } }>(moved);
    expect(movedData.item.task).toMatchObject({ id: inbox.id, projectId: workspaces.alpha });
    const movedAlpha = await request(app).get(`/api/v1/tasks?workspaceId=${workspaces.alpha}`).set({ Cookie: USER_A }).expect(200);
    expect(responseData<{ readonly items: readonly { readonly task: { readonly id: string } }[] }>(movedAlpha).items.map(({ task }) => task.id)).toContain(inbox.id);

    const undone = await request(app).post(`/api/v1/actions/${movedData.receipt.id}/undo`)
      .set({ ...mutationHeaders(USER_A), 'Idempotency-Key': 'r1-undo-inbox-move' }).send({}).expect(200);
    expect(responseData<{ readonly target: { readonly kind: string; readonly item: { readonly task: { readonly id: string; readonly projectId: string | null } } } }>(undone).target)
      .toMatchObject({ kind: 'task', item: { task: { id: inbox.id, projectId: null } } });
    const reloadedInbox = await request(app).get('/api/v1/tasks?inboxOnly=true&limit=100').set({ Cookie: USER_A }).expect(200);
    expect(responseData<{ readonly items: readonly { readonly task: { readonly id: string } }[] }>(reloadedInbox).items.map(({ task }) => task.id)).toContain(inbox.id);
    const receipt = await request(app).get(`/api/v1/actions/${movedData.receipt.id}`).set({ Cookie: USER_A }).expect(200);
    expect(responseData<{ readonly undoStatus: string; readonly undoActionId: string }>(receipt)).toMatchObject({ undoStatus: 'undone' });
    await request(app).get(`/api/v1/tasks/${inbox.id}`).set({ Cookie: USER_B }).expect(404);
    await request(app).post(`/api/v1/tasks/${inbox.id}/move`)
      .set({ ...mutationHeaders(USER_B), 'Idempotency-Key': 'r1-foreign-move', 'If-Match': '"1"' })
      .send({ workspaceId: workspaces.beta }).expect(404);
    await request(app).get(`/api/v1/actions/${movedData.receipt.id}`).set({ Cookie: USER_B }).expect(404);

    const events = await request(app).get(`/api/v1/home/conversations/${homeTurn.conversationId}/events?afterSequence=0`).set({ Cookie: USER_A }).expect(200);
    const eventList = responseData<{ readonly events: readonly { readonly entityId: string | null }[] }>(events).events;
    expect(eventList.some((event) => event.entityId === movedData.receipt.id)).toBe(false);
    await request(app).get(`/api/v1/home/conversations/${homeTurn.conversationId}/events?afterSequence=0`).set({ Cookie: USER_B }).expect(404);
  });

  it('blocks Home bulk proposals and legacy acceptance without writes while preserving other release access rules', async () => {
    const archivedTask = await createTask(USER_A, 'R1 archived workspace task', workspaces.archived, 'r1-archived-task');
    await dataSource.query('UPDATE "projects" SET "status" = \'archived\', "version" = "version" + 1 WHERE "owner_id" = $1 AND "id" = $2', [OWNER_A, workspaces.archived]);
    const archivedPage = await request(app).get(`/api/v1/tasks?workspaceId=${workspaces.archived}&includeArchived=true`).set({ Cookie: USER_A }).expect(200);
    expect(responseData<{ readonly items: readonly { readonly task: { readonly id: string } }[] }>(archivedPage).items.map(({ task }) => task.id)).toContain(archivedTask.id);
    await request(app).patch(`/api/v1/tasks/${archivedTask.id}`)
      .set({ ...mutationHeaders(USER_A), 'Idempotency-Key': 'r1-archived-write', 'If-Match': `"${archivedTask.version}"` })
      .send({ title: 'Must remain read only' }).expect(409);

    await request(app).get(`/api/v1/projects/${workspaces.rootless}/files`).set({ Cookie: USER_A }).expect(409);
    const rootlessConversation = await request(app).post('/api/v1/home/conversations')
      .set({ ...mutationHeaders(USER_A), 'Idempotency-Key': 'r1-rootless-home-conversation' })
      .send({ scope: { kind: 'workspace', workspaceId: workspaces.rootless }, title: 'Rootless planning history' }).expect(201);
    const rootlessConversationData = responseData<{ readonly id: string; readonly scope: { readonly kind: string; readonly workspaceId: string } }>(rootlessConversation);
    const rootlessConversationId = rootlessConversationData.id;
    expect(rootlessConversationData.scope).toEqual({ kind: 'workspace', workspaceId: workspaces.rootless });

    const projectConversation = await request(app).post(`/api/v1/projects/${workspaces.dot}/conversations`)
      .set({ ...mutationHeaders(USER_B), 'Idempotency-Key': 'r1-dot-project-conversation' })
      .send({ title: 'Root project history' }).expect(201);
    const projectConversationId = responseData<{ readonly id: string }>(projectConversation).id;
    await request(app).post(`/api/v1/conversations/${projectConversationId}/messages?projectId=${workspaces.dot}`)
      .set({ ...mutationHeaders(USER_B), 'Idempotency-Key': 'r1-dot-project-message' })
      .send({ content: 'Synthetic existing project chat message.' }).expect(201);
    const projectHistory = await request(app).get(`/api/v1/conversations/${projectConversationId}?projectId=${workspaces.dot}`)
      .set({ Cookie: USER_B }).expect(200);
    expect(JSON.stringify(projectHistory.body)).toContain('Synthetic existing project chat message.');
    const rootFiles = await request(app).get(`/api/v1/projects/${workspaces.dot}/files`).set({ Cookie: USER_B }).expect(200);
    expect(JSON.stringify(rootFiles.body)).toContain('README.md');
    const rootFile = await request(app).get(`/api/v1/projects/${workspaces.dot}/files/content?path=README.md`).set({ Cookie: USER_B }).expect(200);
    expect(responseData<{ readonly content: string }>(rootFile).content).toBe('Managed project fixture file.\n');
    await request(app).get(`/api/v1/projects/${workspaces.dot}/files/content?path=README.md`).set({ Cookie: USER_A }).expect(404);

    const turn = await createActiveHomeTurn('r1-partial-proposal-turn');
    const proposalResult = await planningHandler.resolve({
      ownerId: OWNER_A,
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      requestId: 'r1-partial-proposal',
      name: 'home_propose_bulk_changes',
      scope: { kind: 'home' },
      args: { items: [
        { action: 'task.create', title: 'R1 unsupported bulk task', workspaceId: null },
        { action: 'task.create', title: 'R1 second unsupported bulk task', workspaceId: null }
      ] }
    });
    expect(proposalResult).toBeNull();
    const proposalPath = `/api/v1/home/conversations/${turn.conversationId}/proposals`;
    const history = await request(app).get(proposalPath).set({ Cookie: USER_A }).expect(200);
    expect(responseData<{ readonly proposals: readonly unknown[] }>(history).proposals).toEqual([]);
    const retiredAcceptance = await request(app).post(`${proposalPath}/11111111-1111-4111-8111-111111111111/acceptance`)
      .set(mutationHeaders(USER_A)).send({ expectedRevision: 1 }).expect(409);
    expect(retiredAcceptance.body.error.code).toBe('POLICY_ACTION_RETIRED');
    const savedRows: readonly { readonly count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS "count" FROM "project_tasks" WHERE "owner_id" = $1 AND "title" = $2',
      [OWNER_A, 'R1 unsupported bulk task']
    );
    const secondSavedRows: readonly { readonly count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS "count" FROM "project_tasks" WHERE "owner_id" = $1 AND "title" = $2',
      [OWNER_A, 'R1 second unsupported bulk task']
    );
    const receiptRows: readonly { readonly count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS "count" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "turn_id" = $2',
      [OWNER_A, turn.turnId]
    );
    expect(Number(savedRows[0]?.count)).toBe(0);
    expect(Number(secondSavedRows[0]?.count)).toBe(0);
    expect(Number(receiptRows[0]?.count)).toBe(0);
    const events = await request(app).get(`/api/v1/home/conversations/${turn.conversationId}/events?afterSequence=0`).set({ Cookie: USER_A }).expect(200);
    const actionEvents = responseData<{ readonly events: readonly { readonly type: string; readonly entityId: string | null }[] }>(events).events;
    expect(actionEvents.some(({ type }) => type.startsWith('proposal.'))).toBe(false);
    expect(actionEvents.some(({ type }) => type === 'action.receipt')).toBe(false);
  });

  function initializeApp(): void {
    const projectRepository = new TypeOrmProjectRepository(dataSource);
    const taskRepository = new TypeOrmProjectTaskRepository(dataSource);
    const homeProposalsRepository = new TypeOrmHomeChangeProposalRepository(dataSource);
    homeRepository = new TypeOrmHomeConversationRepository(dataSource);
    const conversationRepository = new TypeOrmConversationRepository(dataSource);
    const ledger = new TypeOrmActionLedgerRepository(dataSource, new TypeOrmHomeActionEventRecorder());
    const taskMutations = new TaskMutationUseCases(ledger, taskRepository, taskRepository);
    const taskQuery = new GetGlobalTaskUseCase(taskRepository);
    const workspaceBoundary = new FixtureWorkspaceBoundary(root, managedRoot);
    const workspacePlanning = new WorkspacePlanningUseCases(projectRepository, projectRepository, ledger, workspaceBoundary);
    const homeProposalUseCases = new HomeChangeProposalUseCases(homeRepository, homeProposalsRepository, taskQuery, taskMutations, workspacePlanning, ledger);
    planningHandler = new HomePlanningToolRequestHandler({
      principalAuthorization: { assertActive: async () => undefined },
      executionPolicy: { assertHome: async () => ({
        policies: [],
        effectiveCapabilities: ['home_task_read', 'home_task_write', 'home_workspace_read', 'home_workspace_write', 'home_action_undo'],
        revisions: { home: '1' }
      }) },
      provider: { profile: 'test-provider', model: 'test-model' },
      conversations: homeRepository,
      listTasks: new ListGlobalTasksUseCase(taskRepository),
      getTask: taskQuery,
      taskMutations,
      workspaces: workspacePlanning,
      undo: new ActionUndoUseCases(ledger, taskRepository, projectRepository)
    });
    const readiness = new InMemoryReadinessState();
    readiness.markReady();
    const getSession = createSessionResolver();
    const gateway = new WorkspaceGatewayAdapter({ containerRoot: root, workspaceBoundary });
    app = createApp({
      logger: createLogger('silent'),
      appVersion: 'test',
      readiness: new GetReadinessUseCase(readiness),
      conversations: {
        getSession,
        listConversations: new ListConversationsUseCase(projectRepository, conversationRepository),
        createConversation: new CreateConversationUseCase(projectRepository, conversationRepository),
        getConversation: new GetConversationUseCase(projectRepository, conversationRepository),
        addUserMessage: new AddUserMessageUseCase(projectRepository, conversationRepository),
        appOrigin: ORIGIN,
        clearSessionCookie: () => undefined
      },
      homeConversations: {
        getSession,
        listConversations: new ListHomeConversationsUseCase(homeRepository),
        createConversation: new CreateHomeConversationUseCase(homeRepository),
        getConversation: new GetConversationHistoryUseCase(homeRepository),
        listTurns: new ListHomeTurnsUseCase(homeRepository),
        submitTurn: new SubmitHomeTurnUseCase(homeRepository),
        decideConsent: new DecideHomeConsentUseCase(homeRepository),
        getTurn: new GetHomeTurnUseCase(homeRepository),
        cancelTurn: new CancelHomeTurnUseCase(homeRepository),
        listMessages: new ListHomeMessagesUseCase(homeRepository),
        listEvents: new ListHomeEventsUseCase(homeRepository),
        appOrigin: ORIGIN,
        clearSessionCookie: () => undefined
      },
      homeProposals: { getSession, proposals: homeProposalUseCases, appOrigin: ORIGIN, clearSessionCookie: () => undefined },
      workspace: {
        getSession,
        listWorkspaceFiles: new ListWorkspaceFilesUseCase(projectRepository, gateway),
        treeWorkspaceFiles: new TreeWorkspaceFilesUseCase(projectRepository, gateway),
        readWorkspaceText: new ReadWorkspaceTextUseCase(projectRepository, gateway),
        searchWorkspaceText: new SearchWorkspaceTextUseCase(projectRepository, gateway),
        clearSessionCookie: () => undefined
      },
      globalTasks: {
        getSession,
        countInboxTasks: new CountInboxTasksUseCase(taskRepository),
        listTasks: new ListGlobalTasksUseCase(taskRepository),
        getTask: taskQuery,
        mutations: taskMutations,
        appOrigin: ORIGIN,
        clearSessionCookie: () => undefined
      },
      actionUndo: { getSession, undoAction: new ActionUndoUseCases(ledger, taskRepository, projectRepository), appOrigin: ORIGIN, clearSessionCookie: () => undefined }
    });
  }

  async function createWorkspace(ownerId: string, id: string, slug: string, relativeRoot: string | null, status: 'active' | 'archived'): Promise<string> {
    const storageKind = relativeRoot === null ? null : 'managed';
    const persistedRoot = storageKind === 'managed' ? `projects/${id}` : relativeRoot;
    const key = persistedRoot?.toLocaleLowerCase('en-US') ?? null;
    if (storageKind === 'managed') {
      const managedProjectRoot = path.join(managedRoot, ownerId, 'projects', id);
      await fs.mkdir(managedProjectRoot, { recursive: true });
      if (id === WORKSPACE_DOT) {
        await fs.writeFile(path.join(managedProjectRoot, 'README.md'), 'Managed project fixture file.\n', 'utf8');
      }
    }
    await dataSource.query(
      'INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "status", "storage_kind") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, ownerId, slug, slug, persistedRoot, key, status, storageKind]
    );
    if (storageKind === 'managed' && persistedRoot && key) {
      await dataSource.query(
        `INSERT INTO "storage_root_mappings" ("owner_id", "project_id", "locator_project_id", "root_key", "storage_kind", "relative_root", "state")
         VALUES ($1, $2, $2, $3, 'managed', $4, 'active')`,
        [ownerId, id, key, persistedRoot]
      );
    }
    return id;
  }

  async function createTask(cookie: string, title: string, workspaceId: string | null, key: string): Promise<TaskCreated> {
    const response = await request(app).post('/api/v1/tasks')
      .set({ ...mutationHeaders(cookie), 'Idempotency-Key': key })
      .send({ title, workspaceId }).expect(201);
    const created = responseData<{ readonly item: { readonly task: { readonly id: string; readonly version: number } }; readonly receipt: { readonly id: string } }>(response);
    return { id: created.item.task.id, version: created.item.task.version, receiptId: created.receipt.id };
  }

  async function createActiveHomeTurn(key: string): Promise<{ readonly conversationId: string; readonly turnId: string }> {
    const conversation = await homeRepository.create({
      ownerId: OWNER_A,
      scope: { kind: 'home' },
      title: `R1 ${key}`,
      requestKey: `${key}-conversation`,
      requestFingerprint: `${key}-fingerprint`
    });
    const submitted = await homeRepository.submitTurn({
      ownerId: OWNER_A,
      conversationId: conversation.resource.id,
      requestKey: `${key}-turn`,
      requestFingerprint: `${key}-turn-fingerprint`,
      message: 'Deterministic release regression fixture; no provider is invoked.',
      initialStatus: 'pending',
      homePolicyRevision: '1',
      workspacePolicyRevision: null
    });
    const running = await homeRepository.updateTurnStatus({
      ownerId: OWNER_A,
      conversationId: conversation.resource.id,
      turnId: submitted.turn.id,
      status: 'running'
    });
    if (!running) throw new Error('The isolated Home fixture turn was not activated.');
    return { conversationId: conversation.resource.id, turnId: running.id };
  }
});

function createSessionResolver(): GetSessionUseCase {
  return {
    execute: async (token: unknown) => {
      const ownerId = token === 'r1-owner-a' ? OWNER_A : token === 'r1-owner-b' ? OWNER_B : null;
      if (!ownerId) throw new UnauthenticatedError();
      return { sessionId: `session-${ownerId}`, principal: { id: ownerId }, csrfToken: 'r1-csrf', expiresAt: new Date('2099-01-01T00:00:00.000Z') };
    }
  } as GetSessionUseCase;
}

function mutationHeaders(cookie: string): Record<string, string> {
  return { Cookie: cookie, Origin: ORIGIN, 'X-CSRF-Token': 'r1-csrf' };
}

function responseData<T>(response: { readonly body: unknown }): T {
  if (typeof response.body !== 'object' || response.body === null || !('data' in response.body)) {
    throw new Error('The HTTP response did not contain a data envelope.');
  }
  return response.body.data as T;
}

async function reconcileReleaseOwners(
  dataSource: DataSource,
  ownerIds: readonly string[],
  boundary: FixtureWorkspaceBoundary,
  recoveryRoot: string
): Promise<void> {
  const quota = new TypeOrmStorageQuotaRepository(dataSource);
  const accounting = new TypeOrmStorageContentAccounting(dataSource, quota);
  const mappingRepository = new TypeOrmStorageRootMappingRepository(dataSource);
  const scanner = new StorageQuotaRootScanner();
  for (const ownerId of ownerIds) {
    const mappings = await mappingRepository.listMappings(ownerId);
    const databaseReferences = await scanDatabaseOwner(dataSource, accounting, ownerId);
    const fileReferences = await scanner.scan([
      ...await resolveReleaseProjectRoots(dataSource, boundary, ownerId, mappings),
      emptyRecoveryRoot(ownerId, recoveryRoot)
    ]);
    await quota.reconcileReferences(ownerId, [...databaseReferences, ...fileReferences]);
  }
}

async function resolveReleaseProjectRoots(
  dataSource: DataSource,
  boundary: FixtureWorkspaceBoundary,
  ownerId: string,
  mappings: readonly StorageRootMapping[]
): Promise<readonly TrustedStorageRoot[]> {
  const projects: readonly {
    readonly id: string;
    readonly relative_root: string;
    readonly relative_root_key: string;
    readonly storage_kind: 'legacy' | 'managed' | null;
  }[] = await dataSource.query(
    'SELECT "id", "relative_root", "relative_root_key", "storage_kind" FROM "projects" WHERE "owner_id" = $1 AND "relative_root" IS NOT NULL',
    [ownerId]
  );
  if (projects.length !== mappings.length) throw new Error('Every rooted R1 fixture project must have one active storage mapping.');
  return Promise.all(mappings.map(async (mapping) => {
    const project = projects.find((row) => row.id === mapping.projectId);
    if (!project || !mapping.projectId || mapping.ownerId !== ownerId || mapping.state !== 'active'
      || mapping.locatorProjectId !== mapping.projectId || mapping.relativeRoot !== project.relative_root
      || mapping.rootKey !== project.relative_root_key || mapping.storageKind !== project.storage_kind
      || (mapping.storageKind === 'managed' && mapping.relativeRoot !== `projects/${mapping.projectId}`)) {
      throw new Error('An R1 fixture root mapping does not match its project row.');
    }
    const resolved = await boundary.resolveProjectRoot({
      ownerId,
      projectId: mapping.projectId,
      storageKind: mapping.storageKind,
      relativeRoot: mapping.relativeRoot
    });
    const canonicalRoot = path.resolve(resolved.canonicalRoot);
    const canonicalProjectRoot = path.resolve(resolved.canonicalProjectRoot);
    if (!isPathWithin(canonicalRoot, canonicalProjectRoot)) throw new Error('An R1 fixture project root escaped its canonical test root.');
    return {
      ownerId,
      projectId: mapping.projectId,
      rootKey: mapping.rootKey,
      absolutePath: canonicalProjectRoot,
      classifyFile: () => 'project_file'
    };
  }));
}

function emptyRecoveryRoot(ownerId: string, recoveryRoot: string): TrustedStorageRoot {
  return {
    ownerId,
    projectId: null,
    rootKey: 'recovery-v1',
    absolutePath: recoveryRoot,
    classifyFile: () => 'recovery_file',
    referenceForFile: () => null
  };
}

async function scanDatabaseOwner(
  dataSource: DataSource,
  accounting: TypeOrmStorageContentAccounting,
  ownerId: string
): Promise<readonly StorageResourceReference[]> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.startTransaction();
    const references = await accounting.scanDatabaseContent(runner, ownerId);
    await runner.commitTransaction();
    return references;
  } catch (error: unknown) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

async function removeFixtureRootsAndMappings(
  dataSource: DataSource,
  ownerIds: readonly string[],
  managedRoot: string
): Promise<void> {
  await removeDirectoryAndVerify(managedRoot);
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const reservations: readonly { readonly count: string }[] = await runner.query(
      'SELECT COUNT(*)::text AS "count" FROM "storage_filesystem_reservations" WHERE "owner_id" = ANY($1::uuid[])',
      [ownerIds]
    );
    if (Number(reservations[0]?.count ?? '0') > 0) throw new Error('R1 fixture roots still have quota reservations at cleanup.');

    const mappings: readonly StorageRootMapping[] = await runner.query(
      `SELECT "owner_id" AS "ownerId", "project_id" AS "projectId", "locator_project_id" AS "locatorProjectId",
        "root_key" AS "rootKey", "storage_kind" AS "storageKind", "relative_root" AS "relativeRoot", "state"
       FROM "storage_root_mappings" WHERE "owner_id" = ANY($1::uuid[]) ORDER BY "owner_id", "root_key"`,
      [ownerIds]
    );
    for (const mapping of mappings) {
      if (mapping.storageKind !== 'managed' || mapping.relativeRoot !== `projects/${mapping.locatorProjectId}`
        || mapping.rootKey !== mapping.relativeRoot.toLowerCase()) {
        throw new Error('Refusing to remove a storage mapping outside the R1 temporary managed fixture.');
      }
    }
    await runner.query('DELETE FROM "storage_resource_references" WHERE "owner_id" = ANY($1::uuid[])', [ownerIds]);
    await runner.query(
      `UPDATE "storage_root_mappings" SET "project_id" = NULL, "state" = 'retained'
       WHERE "owner_id" = ANY($1::uuid[]) AND "state" = 'active'`,
      [ownerIds]
    );
    for (const mapping of mappings) {
      await runner.query("SELECT set_config('app.storage_root_removal_verified', $1, true)", [`${mapping.ownerId}:${mapping.rootKey}`]);
      await runner.query('DELETE FROM "storage_root_mappings" WHERE "owner_id" = $1 AND "root_key" = $2', [mapping.ownerId, mapping.rootKey]);
    }
    await runner.commitTransaction();
  } catch (error: unknown) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

async function removeDirectoryAndVerify(directory: string): Promise<void> {
  if (!directory) return;
  await fs.rm(directory, { recursive: true, force: true });
  try {
    await fs.lstat(directory);
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  throw new Error('An R1 fixture root remained after its verified cleanup.');
}

function isPathWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
