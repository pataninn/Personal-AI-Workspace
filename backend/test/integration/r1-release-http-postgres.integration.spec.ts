import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
import { WorkspaceGatewayAdapter } from '@/infrastructure/workspace/workspace-gateway';
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
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
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
  public async getSnapshot(): Promise<{ readonly status: 'ready' }> { return { status: 'ready' }; }
  public async assertReady(): Promise<void> { return undefined; }
  public async validateProjectRoot(relativeRoot: string): Promise<string> { return relativeRoot; }
}

describeDatabase('R1 release HTTP and PostgreSQL regression', () => {
  const dataSource: DataSource = createDataSource({ url: databaseUrl ?? 'postgres://disabled:disabled@127.0.0.1:1/disabled' });
  let root: string;
  let app: ReturnType<typeof createApp>;
  let homeRepository: TypeOrmHomeConversationRepository;
  let planningHandler: HomePlanningToolRequestHandler;
  let workspaces: WorkspaceIds;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pai-r1-http-pg-'));
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
  });

  afterAll(async () => {
    if (dataSource.isInitialized) {
      await dataSource.query('DROP TRIGGER IF EXISTS "r1_reject_proposal_sentinel" ON "project_tasks"');
      await dataSource.query('DROP FUNCTION IF EXISTS "r1_reject_proposal_sentinel"()');
      await dataSource.query('DELETE FROM "home_change_proposals" WHERE "owner_id" = ANY($1::uuid[])', [[OWNER_A, OWNER_B]]);
      await dataSource.query('DELETE FROM "users" WHERE "id" = ANY($1::uuid[])', [[OWNER_A, OWNER_B]]);
      await dataSource.destroy();
    }
    if (root) await fs.rm(root, { recursive: true, force: true });
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

  it('accepts a deterministic partial proposal, retains event history, and preserves archived, rootless, root-dot, and project-chat access rules', async () => {
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
    expect(responseData<{ readonly content: string }>(rootFile).content).toBe('Root project fixture file.\n');
    await request(app).get(`/api/v1/projects/${workspaces.dot}/files/content?path=README.md`).set({ Cookie: USER_A }).expect(404);

    const turn = await createActiveHomeTurn('r1-partial-proposal-turn');
    await dataSource.query(`
      CREATE FUNCTION "r1_reject_proposal_sentinel"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."title" = 'R1 partial failure sentinel' THEN
          RAISE EXCEPTION 'deterministic release fixture failure' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await dataSource.query('CREATE TRIGGER "r1_reject_proposal_sentinel" BEFORE INSERT ON "project_tasks" FOR EACH ROW EXECUTE FUNCTION "r1_reject_proposal_sentinel"()');
    const proposalResult = await planningHandler.resolve({
      ownerId: OWNER_A,
      conversationId: turn.conversationId,
      turnId: turn.turnId,
      requestId: 'r1-partial-proposal',
      name: 'home_propose_bulk_changes',
      scope: { kind: 'home' },
      args: { items: [
        { action: 'task.create', title: 'R1 accepted proposal task', workspaceId: null },
        { action: 'task.create', title: 'R1 partial failure sentinel', workspaceId: null }
      ] }
    });
    if (!proposalResult || proposalResult.kind !== 'immediate') throw new Error('The deterministic proposal fixture did not create a review proposal.');
    const proposalInfo = proposalResult.result.data.proposal;
    if (!proposalInfo || typeof proposalInfo !== 'object' || !('id' in proposalInfo) || typeof proposalInfo.id !== 'string') throw new Error('The proposal response omitted its ID.');
    const proposalId = proposalInfo.id;
    const proposalPath = `/api/v1/home/conversations/${turn.conversationId}/proposals/${proposalId}`;
    const detail = await request(app).get(proposalPath).set({ Cookie: USER_A }).expect(200);
    const proposal = responseData<{ readonly proposal: { readonly revision: number; readonly items: readonly { readonly id: string }[] } }>(detail).proposal;
    expect(proposal.items).toHaveLength(2);
    await request(app).get(proposalPath).set({ Cookie: USER_B }).expect(404);
    const accepted = await request(app).post(`${proposalPath}/acceptance`)
      .set(mutationHeaders(USER_A)).send({ expectedRevision: proposal.revision }).expect(201);
    const acceptance = responseData<{ readonly replayed: boolean; readonly proposal: { readonly state: string }; readonly execution: { readonly state: string; readonly items: readonly { readonly itemId: string; readonly state: string; readonly receiptId: string | null }[] } }>(accepted);
    expect(acceptance).toMatchObject({ replayed: false, proposal: { state: 'partial' }, execution: { state: 'partial' } });
    expect(acceptance.execution.items.map(({ state }) => state)).toEqual(['saved', 'failed']);
    expect(acceptance.execution.items[0]?.receiptId).toBeTruthy();
    expect(acceptance.execution.items[1]?.receiptId).toBeNull();
    const replay = await request(app).post(`${proposalPath}/acceptance`)
      .set(mutationHeaders(USER_A)).send({ expectedRevision: proposal.revision }).expect(200);
    expect(responseData<{ readonly replayed: boolean }>(replay).replayed).toBe(true);
    const savedRows: readonly { readonly count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS "count" FROM "project_tasks" WHERE "owner_id" = $1 AND "title" = $2',
      [OWNER_A, 'R1 accepted proposal task']
    );
    const receiptRows: readonly { readonly count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS "count" FROM "action_ledger_records" WHERE "owner_id" = $1 AND "id" = $2',
      [OWNER_A, acceptance.execution.items[0]?.receiptId]
    );
    expect(Number(savedRows[0]?.count)).toBe(1);
    expect(Number(receiptRows[0]?.count)).toBe(1);
    const events = await request(app).get(`/api/v1/home/conversations/${turn.conversationId}/events?afterSequence=0`).set({ Cookie: USER_A }).expect(200);
    const actionEvents = responseData<{ readonly events: readonly { readonly type: string; readonly entityId: string | null }[] }>(events).events;
    expect(actionEvents.some(({ type }) => type === 'proposal.created')).toBe(true);
    expect(actionEvents.some(({ type }) => type === 'proposal.item_status_changed')).toBe(true);
    expect(actionEvents.some(({ type, entityId }) => type === 'action.receipt' && entityId === acceptance.execution.items[0]?.receiptId)).toBe(true);
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
    const workspaceBoundary = new FixtureWorkspaceBoundary();
    const workspacePlanning = new WorkspacePlanningUseCases(projectRepository, projectRepository, ledger, workspaceBoundary);
    const homeProposalUseCases = new HomeChangeProposalUseCases(homeRepository, homeProposalsRepository, taskQuery, taskMutations, workspacePlanning, ledger);
    planningHandler = new HomePlanningToolRequestHandler({
      conversations: homeRepository,
      listTasks: new ListGlobalTasksUseCase(taskRepository),
      getTask: taskQuery,
      taskMutations,
      workspaces: workspacePlanning,
      undo: new ActionUndoUseCases(ledger, taskRepository, projectRepository),
      proposals: homeProposalUseCases
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
    const key = relativeRoot?.toLocaleLowerCase('en-US') ?? null;
    await dataSource.query(
      'INSERT INTO "projects" ("id", "owner_id", "name", "slug", "relative_root", "relative_root_key", "status") VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, ownerId, slug, slug, relativeRoot, key, status]
    );
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
      initialStatus: 'pending'
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
