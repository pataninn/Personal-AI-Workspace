import type { AssistantExecutionAuthorization } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import type { HomeConversation, HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { SkillInvocation } from '@/modules/skills/domain/skill-invocation-types';
import { HomePlanningToolRequestHandler } from '@/modules/home-assistant/use-cases/home-planning-tool-request-handler';
import type { HomePlanningToolRequest } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';
import { ProjectTaskVersionConflictError, ProjectTaskIdempotencyReusedError } from '@/modules/tasks/domain/project-task-errors';
import { ProjectVersionConflictError } from '@/modules/projects/domain/project-errors';

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

function setup(options: {
  readonly capabilities?: readonly AssistantExecutionAuthorization['effectiveCapabilities'][number][];
  readonly scope?: HomeConversation['scope'];
  readonly relativeRoot?: string | null;
  readonly skillInvocation?: SkillInvocation | null;
  readonly boundInvocationSourceMissing?: boolean;
  readonly missingSkillInvocationRepository?: boolean;
} = {}) {
  const conversation = { ...homeConversation, scope: options.scope ?? homeConversation.scope };
  const project = { id: PROJECT, ownerId: OWNER, name: 'Roadmap', slug: 'roadmap', relativeRoot: options.relativeRoot ?? null, storageKind: 'managed' as const, objective: null, status: 'active' as const, version: 1, createdAt: NOW, updatedAt: NOW };
  const assertActive = jest.fn(async () => undefined);
  const conversations = {
    findForOwner: jest.fn(async () => conversation),
    findTurnForOwner: jest.fn(async () => {
      const skillInvocationId = options.skillInvocation?.id
        ?? (options.boundInvocationSourceMissing ? '99999999-9999-4999-8999-999999999999' : undefined);
      return options.scope?.kind === 'workspace'
        ? { ...homeTurn, workspacePolicyRevision: '9', ...(skillInvocationId ? { skillInvocationId } : {}) }
        : { ...homeTurn, ...(skillInvocationId ? { skillInvocationId } : {}) };
    })
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
  const taskMutations = {
    create: jest.fn(async () => ({ receipt: { id: 'receipt-1', actionKind: 'task.create', targetKind: 'task', targetId: TASK, outcome: { targetVersion: 1 }, undoStatus: 'available' }, replayed: false })),
    update: jest.fn(async () => ({ receipt: { id: 'receipt-3', actionKind: 'task.update', targetKind: 'task', targetId: TASK, outcome: { targetVersion: 2 }, undoStatus: 'available' }, replayed: false })),
    findDeleteReplay: jest.fn(async () => null as unknown),
    delete: jest.fn(async () => ({ receipt: { id: 'receipt-delete', actionKind: 'task.delete', targetKind: 'task', targetId: TASK, outcome: { sourceOrderVersion: 2 }, undoStatus: 'not_reversible' }, replayed: false }))
  };
  const workspaces = {
    reuse: jest.fn(async () => project),
    search: jest.fn(async () => ({ projects: [project], limit: 10, hasMore: false })),
    createPlanning: jest.fn(async () => ({ receipt: { id: 'receipt-2', actionKind: 'workspace.create', targetKind: 'workspace', targetId: PROJECT, outcome: { targetVersion: 1 }, undoStatus: 'available' }, replayed: false })),
    updateObjective: jest.fn(async () => ({ receipt: { id: 'receipt-4', actionKind: 'workspace.update', targetKind: 'workspace', targetId: PROJECT, outcome: { targetVersion: 2 }, undoStatus: 'available' }, replayed: false }))
  };
  const undoReceipt = { id: 'receipt-1', ownerId: OWNER, actionKind: 'task.create', targetKind: 'task' as 'task' | 'workspace', targetId: TASK, outcome: { targetVersion: 1 }, undoStatus: 'available' };
  const undo = {
    findUndoReplay: jest.fn(async () => null as unknown),
    getReceipt: jest.fn(async () => undoReceipt),
    undo: jest.fn(async () => ({ undoReceipt, replayed: false }))
  };
  const skillInvocations = { findForTurn: jest.fn(async () => options.boundInvocationSourceMissing ? null : options.skillInvocation ?? null) };
  const handler = new HomePlanningToolRequestHandler({
    principalAuthorization: { assertActive }, executionPolicy: { assertHome } as never, provider: { profile: 'profile', model: 'model' },
    conversations: conversations as unknown as IHomeConversationRepository,
    ...(!options.missingSkillInvocationRepository ? { skillInvocations } : {}),
    listTasks: listTasks as never, getTask: getTask as never, taskMutations: taskMutations as never,
    workspaces: workspaces as never, undo: undo as never
  });
  return { handler, assertActive, assertHome, listTasks, getTask, taskMutations, workspaces, undoReceipt, undo, skillInvocations };
}

function makeSkillInvocation(overrides: Partial<SkillInvocation> = {}): SkillInvocation {
  return {
    id: '66666666-6666-4666-8666-666666666666', ownerId: OWNER, conversationId: CONVERSATION,
    skillId: '77777777-7777-4777-8777-777777777777', skillRevisionId: '88888888-8888-4888-8888-888888888888',
    skillVersion: 1, requestKeyDigest: 'a'.repeat(64), requestFingerprint: 'b'.repeat(64), contextRevisions: [],
    declaredTools: ['home_task_read'], title: 'Read', instructions: 'Read tasks.', enabled: true, state: 'accepted',
    turnId: TURN, createdAt: NOW, updatedAt: NOW, current: true, ...overrides
  };
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

  it('intersects declared skill capabilities with current policy before executing a Home tool', async () => {
    const { handler, taskMutations, skillInvocations } = setup({ skillInvocation: makeSkillInvocation({ declaredTools: ['home_task_read'] }) });

    const result = await handler.resolve(request('home_create_task', { title: 'Prepare review' }));

    expect(result).toBeNull();
    expect(skillInvocations.findForTurn).toHaveBeenCalledWith(OWNER, CONVERSATION, TURN);
    expect(taskMutations.create).not.toHaveBeenCalled();
  });

  it('blocks a tool when the invoked skill is disabled or is no longer at its invocation version', async () => {
    const { handler, listTasks } = setup({ skillInvocation: makeSkillInvocation({ enabled: false, current: false }) });

    const result = await handler.resolve(request('home_list_tasks', { limit: 1 }));

    expect(result).toBeNull();
    expect(listTasks.execute).not.toHaveBeenCalled();
  });

  it('fails closed when a skill-bound turn has no invocation lookup available', async () => {
    const { handler, listTasks } = setup({ skillInvocation: makeSkillInvocation(), missingSkillInvocationRepository: true });

    const result = await handler.resolve(request('home_list_tasks', { limit: 1 }));

    expect(result).toBeNull();
    expect(listTasks.execute).not.toHaveBeenCalled();
  });

  it('denies a surviving bound turn when its skill source cannot be resolved', async () => {
    const { handler, listTasks, skillInvocations } = setup({ boundInvocationSourceMissing: true });

    const result = await handler.resolve(request('home_list_tasks', { limit: 1 }));

    expect(result).toBeNull();
    expect(skillInvocations.findForTurn).toHaveBeenCalledWith(OWNER, CONVERSATION, TURN);
    expect(listTasks.execute).not.toHaveBeenCalled();
  });

  it('rechecks workspace policy for a Home tool target and returns only an internal authorization id', async () => {
    const { handler, assertHome } = setup({ capabilities: ['home_workspace_read'] });

    const result = await handler.resolve(request('home_reuse_workspace', { workspaceId: PROJECT }));

    expect(assertHome).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, projectId: PROJECT, homePolicyRevision: '7' }));
    expect(result).toMatchObject({ kind: 'immediate', authorizationProjectId: PROJECT, result: { outcome: 'shared' } });
    expect(JSON.stringify(result?.kind === 'immediate' ? result.result : result)).not.toContain('authorizationProjectId');
  });

  it('allows an active file-backed workspace conversation to read only its own tasks', async () => {
    const scope = { kind: 'workspace' as const, workspaceId: PROJECT };
    const { handler, listTasks, assertHome } = setup({ scope, relativeRoot: 'workspaces/roadmap' });

    const result = await handler.resolve(request('home_list_tasks', { limit: 1 }, scope));

    expect(result).toMatchObject({ kind: 'immediate', result: { outcome: 'shared', data: { items: [] } } });
    expect(listTasks.execute).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: OWNER, filters: expect.objectContaining({ workspaceId: PROJECT, inboxOnly: false })
    }));
    expect(assertHome).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, projectId: PROJECT, workspacePolicyRevision: '9' }));
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

  it('returns an exact undo receipt after current gates without reading or mutating the task', async () => {
    const { handler, assertActive, assertHome, getTask, undoReceipt, undo, skillInvocations } = setup({
      skillInvocation: makeSkillInvocation({ declaredTools: ['home_action_undo'] })
    });
    const replayReceipt = { ...undoReceipt, id: 'receipt-undo', actionKind: 'undo', undoStatus: 'not_reversible' };
    undo.findUndoReplay.mockResolvedValueOnce(replayReceipt as never);

    const result = await handler.resolve(request('home_undo_action', { actionId: '66666666-6666-4666-8666-666666666666' }));

    expect(result).toMatchObject({ kind: 'immediate', result: { outcome: 'shared', data: { receipt: { id: 'receipt-undo' }, replayed: true } } });
    expect(assertActive).toHaveBeenCalledTimes(2);
    expect(assertHome).toHaveBeenCalledTimes(1);
    expect(skillInvocations.findForTurn).toHaveBeenCalledWith(OWNER, CONVERSATION, TURN);
    expect(undo.findUndoReplay).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: OWNER, actionId: '66666666-6666-4666-8666-666666666666',
      operationKey: expect.stringMatching(/^home-tool:[0-9a-f]{64}$/u), actorKind: 'assistant', turnId: TURN
    }));
    expect(undo.getReceipt).not.toHaveBeenCalled();
    expect(getTask.execute).not.toHaveBeenCalled();
    expect(undo.undo).not.toHaveBeenCalled();
  });

  it('checks mutation capability again immediately before the canonical task command', async () => {
    const { handler, taskMutations, assertHome } = setup({ capabilities: ['home_task_write'] });

    const result = await handler.resolve(request('home_create_task', { title: 'Prepare review' }));

    expect(assertHome).toHaveBeenCalledTimes(2);
    expect(taskMutations.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, projectId: null, actorKind: 'assistant', turnId: TURN }));
    expect(result).toMatchObject({ kind: 'immediate', result: { outcome: 'shared' } });
  });

  it('returns an exact delete receipt after current gates without reading or mutating the deleted task', async () => {
    const { handler, assertActive, assertHome, getTask, taskMutations, skillInvocations } = setup({ skillInvocation: makeSkillInvocation({ declaredTools: ['home_task_write'] }) });
    const receipt = { id: 'receipt-delete', actionKind: 'task.delete', targetKind: 'task', targetId: TASK, outcome: { sourceOrderVersion: 2 }, undoStatus: 'not_reversible' };
    taskMutations.findDeleteReplay.mockResolvedValueOnce({ taskId: TASK, orderVersion: 2, receipt, replayed: true } as never);

    const result = await handler.resolve(request('home_delete_task', { taskId: TASK, expectedVersion: 3 }));

    expect(result).toMatchObject({ kind: 'immediate', result: { outcome: 'shared', data: { receipt: { id: receipt.id }, replayed: true } } });
    expect(assertActive).toHaveBeenCalledTimes(2);
    expect(assertHome).toHaveBeenCalledTimes(1);
    expect(skillInvocations.findForTurn).toHaveBeenCalledWith(OWNER, CONVERSATION, TURN);
    expect(taskMutations.findDeleteReplay).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, taskId: TASK, expectedVersion: 3, actorKind: 'assistant', turnId: TURN }));
    expect(getTask.execute).not.toHaveBeenCalled();
    expect(taskMutations.delete).not.toHaveBeenCalled();
  });

  it('returns a bounded non-applied conflict for exact canonical expected-version errors only', async () => {
    const { handler, taskMutations, workspaces } = setup();
    taskMutations.update.mockRejectedValueOnce(new ProjectTaskVersionConflictError());
    const taskConflict = await handler.resolve(request('home_update_task', { taskId: TASK, expectedVersion: 1, title: 'Updated task' }));

    expect(taskConflict).toEqual({ kind: 'immediate', result: { outcome: 'conflict', code: 'VERSION_CONFLICT' } });

    workspaces.updateObjective.mockRejectedValueOnce(new ProjectVersionConflictError());
    const workspaceConflict = await handler.resolve(request('home_update_workspace_objective', { workspaceId: PROJECT, expectedVersion: 1, objective: 'New objective' }));

    expect(workspaceConflict).toEqual({ kind: 'immediate', result: { outcome: 'conflict', code: 'VERSION_CONFLICT' } });

    taskMutations.update.mockRejectedValueOnce(new ProjectTaskIdempotencyReusedError());
    await expect(handler.resolve(request('home_update_task', { taskId: TASK, expectedVersion: 1, title: 'Updated task' })))
      .rejects.toBeInstanceOf(ProjectTaskIdempotencyReusedError);
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
