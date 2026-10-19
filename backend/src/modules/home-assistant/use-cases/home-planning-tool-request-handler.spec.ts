import type { AssistantExecutionAuthorization } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import type { HomeConversation, HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import { HomePlanningToolRequestHandler } from '@/modules/home-assistant/use-cases/home-planning-tool-request-handler';
import type { HomePlanningToolRequest } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const TASK = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-19T00:00:00.000Z');

const homeConversation: HomeConversation = {
  id: CONVERSATION, ownerId: OWNER, scope: { kind: 'home' }, title: 'Home', lastEventSequence: 1,
  lastActivityAt: NOW, createdAt: NOW, updatedAt: NOW
};
const homeTurn: HomeTurn = {
  id: TURN, ownerId: OWNER, conversationId: CONVERSATION, sequence: 1, requestKey: 'request-1', status: 'running',
  homePolicyRevision: '7', workspacePolicyRevision: null, createdAt: NOW, updatedAt: NOW
};

function setup(options: { readonly capabilities?: readonly AssistantExecutionAuthorization['effectiveCapabilities'][number][]; readonly scope?: HomeConversation['scope'] } = {}) {
  const conversation = { ...homeConversation, scope: options.scope ?? homeConversation.scope };
  const project = { id: PROJECT, ownerId: OWNER, name: 'Roadmap', slug: 'roadmap', relativeRoot: null, storageKind: 'managed' as const, objective: null, status: 'active' as const, version: 1, createdAt: NOW, updatedAt: NOW };
  const assertActive = jest.fn(async () => undefined);
  const conversations = {
    findForOwner: jest.fn(async () => conversation),
    findTurnForOwner: jest.fn(async () => options.scope?.kind === 'workspace'
      ? { ...homeTurn, workspacePolicyRevision: '9' }
      : homeTurn)
  };
  const assertHome = jest.fn(async (input: { readonly ownerId: string; readonly projectId?: string }) => ({
    policies: [], effectiveCapabilities: options.capabilities ?? ['home_task_read', 'home_task_write', 'home_workspace_read', 'home_workspace_write', 'home_action_undo'],
    revisions: { home: '7', ...(input.projectId ? { workspace: '9' } : {}) }
  } satisfies AssistantExecutionAuthorization));
  const listTasks = { execute: jest.fn(async () => ({ items: [], nextCursor: null })) };
  const getTask = { execute: jest.fn(async () => ({
    task: { id: TASK, ownerId: OWNER, projectId: null, title: 'Task', details: null, status: 'todo', importance: 'medium', deadline: null, version: 1, subtasks: [] },
    workspace: null
  })) };
  const taskMutations = { create: jest.fn(async () => ({ receipt: { id: 'receipt-1', actionKind: 'task.create', targetKind: 'task', targetId: TASK, outcome: { targetVersion: 1 }, undoStatus: 'available' }, replayed: false })) };
  const workspaces = {
    reuse: jest.fn(async () => project),
    search: jest.fn(async () => ({ projects: [project], limit: 10, hasMore: false })),
    createPlanning: jest.fn(async () => ({ receipt: { id: 'receipt-2', actionKind: 'workspace.create', targetKind: 'workspace', targetId: PROJECT, outcome: { targetVersion: 1 }, undoStatus: 'available' }, replayed: false }))
  };
  const undoReceipt = { id: 'receipt-1', ownerId: OWNER, actionKind: 'task.create', targetKind: 'task' as 'task' | 'workspace', targetId: TASK, outcome: { targetVersion: 1 }, undoStatus: 'available' };
  const undo = { getReceipt: jest.fn(async () => undoReceipt), undo: jest.fn(async () => ({ undoReceipt, replayed: false })) };
  const handler = new HomePlanningToolRequestHandler({
    principalAuthorization: { assertActive }, executionPolicy: { assertHome } as never, provider: { profile: 'profile', model: 'model' },
    conversations: conversations as unknown as IHomeConversationRepository,
    listTasks: listTasks as never, getTask: getTask as never, taskMutations: taskMutations as never,
    workspaces: workspaces as never, undo: undo as never
  });
  return { handler, assertHome, listTasks, taskMutations, workspaces, undoReceipt, undo };
}

function request(name: string, args: Readonly<Record<string, unknown>>, scope: HomeConversation['scope'] = { kind: 'home' }): HomePlanningToolRequest {
  return { ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, requestId: 'tool-request-1', name, args, scope };
}

describe('HomePlanningToolRequestHandler', () => {
  it('returns an in-scope task read immediately with no consent continuation', async () => {
    const { handler, listTasks, assertHome } = setup();

    const result = await handler.resolve(request('home_list_tasks', { limit: 1 }));

    expect(listTasks.execute).toHaveBeenCalledTimes(1);
    expect(assertHome).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, homePolicyRevision: '7' }));
    expect(result).toMatchObject({ kind: 'immediate', result: { outcome: 'shared', data: { items: [] } } });
  });

  it('does not read tasks when the stored policy omits the required capability', async () => {
    const { handler, listTasks } = setup({ capabilities: ['home_workspace_read'] });

    const result = await handler.resolve(request('home_list_tasks', { limit: 1 }));

    expect(result).toBeNull();
    expect(listTasks.execute).not.toHaveBeenCalled();
  });

  it('rechecks workspace policy for a Home tool target and returns only an internal authorization id', async () => {
    const { handler, assertHome } = setup({ capabilities: ['home_workspace_read'] });

    const result = await handler.resolve(request('home_reuse_workspace', { workspaceId: PROJECT }));

    expect(assertHome).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, projectId: PROJECT, homePolicyRevision: '7' }));
    expect(result).toMatchObject({ kind: 'immediate', authorizationProjectId: PROJECT, result: { outcome: 'shared' } });
    expect(JSON.stringify(result?.kind === 'immediate' ? result.result : result)).not.toContain('authorizationProjectId');
  });

  it('allows a Home turn to undo an owned workspace action only after checking that workspace policy', async () => {
    const { handler, assertHome, undoReceipt, undo } = setup();
    undoReceipt.targetKind = 'workspace';
    undoReceipt.targetId = PROJECT;
    undoReceipt.actionKind = 'workspace.create';

    const result = await handler.resolve(request('home_undo_action', { actionId: '66666666-6666-4666-8666-666666666666' }));

    expect(assertHome).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, projectId: PROJECT, homePolicyRevision: '7' }));
    expect(undo.undo).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, actionId: '66666666-6666-4666-8666-666666666666', actorKind: 'assistant', turnId: TURN }));
    expect(result).toMatchObject({ kind: 'immediate', result: { outcome: 'shared' } });
  });

  it('checks mutation capability again immediately before the canonical task command', async () => {
    const { handler, taskMutations, assertHome } = setup({ capabilities: ['home_task_write'] });

    const result = await handler.resolve(request('home_create_task', { title: 'Prepare review' }));

    expect(assertHome).toHaveBeenCalledTimes(2);
    expect(taskMutations.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, projectId: null, actorKind: 'assistant', turnId: TURN }));
    expect(result).toMatchObject({ kind: 'immediate', result: { outcome: 'shared' } });
  });

  it('keeps bulk proposal tools blocked without creating a proposal', async () => {
    const { handler, workspaces } = setup();

    const result = await handler.resolve(request('home_propose_bulk_changes', { items: [
      { action: 'workspace.create', name: 'One' }, { action: 'workspace.create', name: 'Two' }
    ] }));

    expect(result).toBeNull();
    expect(workspaces.createPlanning).not.toHaveBeenCalled();
  });
});
