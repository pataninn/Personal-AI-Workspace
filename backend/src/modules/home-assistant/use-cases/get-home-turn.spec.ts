import type { AssistantToolCapability } from '@/modules/assistant-policy/domain/assistant-scope-policy';
import type { AssistantExecutionAuthorization, AssertAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import type { HomeConversation, HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import type { IHomePlanningToolRequestHandler } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';
import { GetHomeTurnUseCase } from '@/modules/home-assistant/use-cases/get-home-turn';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const PROVIDER = 'nvidia-hosted-nim';
const MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const NOW = new Date('2026-10-16T00:00:00.000Z');

function makeTurn(
  status: HomeTurn['status'],
  revisions: { home: string | null; workspace: string | null } = { home: '4', workspace: null },
  automationOccurrenceId?: string
): HomeTurn {
  return {
    id: TURN, ownerId: OWNER, conversationId: CONVERSATION, sequence: 1, requestKey: 'submit-1', status,
    homePolicyRevision: revisions.home, workspacePolicyRevision: revisions.workspace, createdAt: NOW, updatedAt: NOW,
    ...(automationOccurrenceId ? { automationOccurrenceId } : {})
  };
}

function makeConversation(scope: HomeConversation['scope'] = { kind: 'home' }): HomeConversation {
  return {
    id: CONVERSATION, ownerId: OWNER, scope, title: 'Home', lastEventSequence: 1,
    lastActivityAt: NOW, createdAt: NOW, updatedAt: NOW
  };
}

function setup(options: {
  readonly events?: readonly { readonly sequence: number; readonly type: 'assistant.delta'; readonly text: string }[] | readonly { readonly sequence: number; readonly type: 'home.tool.requested'; readonly requestId: string; readonly sessionId: string; readonly name: string; readonly args: Readonly<Record<string, unknown>> }[];
  readonly revisions?: { home: string | null; workspace: string | null };
  readonly scope?: HomeConversation['scope'];
  readonly handlerResult?: Awaited<ReturnType<IHomePlanningToolRequestHandler['resolve']>>;
  readonly assertFailsAt?: number;
  readonly sendAccepted?: boolean;
  readonly cancelConfirmed?: boolean;
  readonly initialStatus?: HomeTurn['status'];
  readonly automationOccurrenceId?: string;
} = {}) {
  let status: HomeTurn['status'] = options.initialStatus ?? 'running';
  const revisions = options.revisions ?? { home: '4', workspace: null };
  const conversation = makeConversation(options.scope);
  const currentTurn = () => makeTurn(status, revisions, options.automationOccurrenceId);
  const conversations = {
    findForOwner: jest.fn(async () => conversation),
    findTurnForOwner: jest.fn(async () => currentTurn()),
    completeTurnWithAssistant: jest.fn(async ({ status: nextStatus }: { status: 'completed' | 'partial' }) => {
      status = nextStatus;
      return currentTurn();
    }),
    updateTurnStatus: jest.fn(async ({ status: nextStatus }: { status: 'failed' | 'cancelled' | 'unknown' | 'unsupported' }) => {
      status = nextStatus;
      return currentTurn();
    })
  };
  const events = options.events ?? [];
  const runtime = {
    supportsPolicyExecution: jest.fn(async () => true),
    poll: jest.fn(async () => ({ status: 'completed' as const, events, nextCursor: events.length, hasMore: false })),
    sendToolResult: jest.fn(async () => ({ accepted: options.sendAccepted ?? true })),
    cancel: jest.fn(async () => ({ outcome: options.cancelConfirmed === false ? 'unknown' as const : 'confirmed' as const })),
    delete: jest.fn(async () => undefined)
  };
  let assertions = 0;
  const authorization: AssistantExecutionAuthorization = {
    policies: [],
    effectiveCapabilities: ['home_task_read', 'home_task_write', 'home_workspace_read', 'home_workspace_write', 'home_action_undo'],
    revisions: { home: '4', ...(options.scope?.kind === 'workspace' ? { workspace: '9' } : {}) }
  };
  const executionPolicy = {
    assertHome: jest.fn(async () => {
      assertions += 1;
      if (assertions === options.assertFailsAt) throw new Error('policy changed');
      return authorization;
    })
  };
  const handler = { resolve: jest.fn(async () => options.handlerResult ?? null) };
  const useCase = new GetHomeTurnUseCase(
    conversations as unknown as IHomeConversationRepository,
    runtime as unknown as IHomePlanningRuntime,
    undefined,
    handler as unknown as IHomePlanningToolRequestHandler,
    { executionPolicy: executionPolicy as unknown as Pick<AssertAssistantExecutionPolicyUseCase, 'assertHome'>, providerProfile: PROVIDER, model: MODEL }
  );
  return { useCase, conversations, runtime, executionPolicy, handler };
}

describe('GetHomeTurnUseCase', () => {
  it('does not poll or resume a legacy turn without a persisted policy binding', async () => {
    const { useCase, conversations, runtime } = setup({ revisions: { home: null, workspace: null } });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(runtime.poll).not.toHaveBeenCalled();
    expect(runtime.cancel).toHaveBeenCalledWith(TURN);
    expect(conversations.updateTurnStatus).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, status: 'cancelled' });
    expect(result.status).toBe('cancelled');
  });

  it('blocks before polling when the current stored policy is unavailable', async () => {
    const { useCase, conversations, runtime } = setup({ assertFailsAt: 1 });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(runtime.poll).not.toHaveBeenCalled();
    expect(conversations.completeTurnWithAssistant).not.toHaveBeenCalled();
    expect(result.status).toBe('cancelled');
  });

  it('stores a completed assistant result only after the policy remains current', async () => {
    const { useCase, conversations, runtime, executionPolicy } = setup({
      events: [{ sequence: 1, type: 'assistant.delta', text: 'The answer is safe.' }]
    });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(executionPolicy.assertHome).toHaveBeenCalledTimes(2);
    expect(conversations.completeTurnWithAssistant).toHaveBeenCalledWith({
      ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, content: 'The answer is safe.', status: 'completed'
    });
    expect(result.status).toBe('completed');
    expect(runtime.delete).toHaveBeenCalledWith(TURN);
  });

  it('sends an immediate tool result only after current policy checks and never asks for consent', async () => {
    const event = { sequence: 1, type: 'home.tool.requested' as const, requestId: 'request-1', sessionId: 'session-1', name: 'home_list_tasks', args: { limit: 1 } };
    const { useCase, runtime, executionPolicy, handler } = setup({
      events: [event],
      handlerResult: { kind: 'immediate', result: { outcome: 'shared', data: { items: [] } } }
    });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(handler.resolve).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, requestId: 'request-1', name: 'home_list_tasks', args: { limit: 1 }, scope: { kind: 'home' } });
    expect(runtime.sendToolResult).toHaveBeenCalledWith({ turnId: TURN, requestId: 'request-1', result: { outcome: 'shared', data: { items: [] } } });
    expect(executionPolicy.assertHome).toHaveBeenCalledTimes(4);
    expect(result.status).toBe('completed');
  });

  it('does not execute a new tool request while reconciling an unknown scheduled turn', async () => {
    const occurrenceId = '77777777-7777-4777-8777-777777777777';
    const event = { sequence: 1, type: 'home.tool.requested' as const, requestId: 'tool-after-unknown', sessionId: 'session-1', name: 'home_list_tasks', args: { limit: 1 } };
    const { useCase, runtime, handler, conversations } = setup({
      events: [event], initialStatus: 'unknown', automationOccurrenceId: occurrenceId,
      scope: { kind: 'workspace', workspaceId: PROJECT }, revisions: { home: '4', workspace: '9' },
      handlerResult: { kind: 'immediate', result: { outcome: 'shared', data: { items: [] } } }
    });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, automationGuard: {
      fence: { occurrenceId, leaseToken: 'lease-token', generation: 1 }, isCurrent: async () => true
    } });

    expect(handler.resolve).not.toHaveBeenCalled();
    expect(runtime.sendToolResult).not.toHaveBeenCalled();
    expect(conversations.completeTurnWithAssistant).not.toHaveBeenCalled();
    expect(result.status).toBe('unknown');
  });

  it('continues with the bounded version-conflict result after current policy checks', async () => {
    const event = { sequence: 1, type: 'home.tool.requested' as const, requestId: 'request-conflict', sessionId: 'session-1', name: 'home_update_task', args: { taskId: PROJECT, expectedVersion: 1, title: 'Updated task' } };
    const { useCase, runtime } = setup({
      events: [event],
      handlerResult: { kind: 'immediate', result: { outcome: 'conflict', code: 'VERSION_CONFLICT' } }
    });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(runtime.sendToolResult).toHaveBeenCalledWith({ turnId: TURN, requestId: 'request-conflict', result: { outcome: 'conflict', code: 'VERSION_CONFLICT' } });
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });

  it('suppresses continuation when policy changes after resolving a tool result', async () => {
    const event = { sequence: 1, type: 'home.tool.requested' as const, requestId: 'request-1', sessionId: 'session-1', name: 'home_list_tasks', args: { limit: 1 } };
    const { useCase, conversations, runtime } = setup({
      events: [event], assertFailsAt: 3,
      handlerResult: { kind: 'immediate', result: { outcome: 'shared', data: { items: [] } } }
    });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(runtime.sendToolResult).not.toHaveBeenCalled();
    expect(conversations.completeTurnWithAssistant).not.toHaveBeenCalled();
    expect(conversations.updateTurnStatus).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, status: 'cancelled' });
    expect(result.status).toBe('cancelled');
  });

  it('does not send a denial or consent continuation for an unsupported tool resolution', async () => {
    const event = { sequence: 1, type: 'home.tool.requested' as const, requestId: 'request-1', sessionId: 'session-1', name: 'home_list_tasks', args: { limit: 1 } };
    const { useCase, runtime } = setup({ events: [event], handlerResult: { kind: 'consented', candidate: {
      scope: { kind: 'home' }, categories: ['task_metadata'], itemCount: 1, data: { items: [] }
    } } });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(runtime.sendToolResult).not.toHaveBeenCalled();
    expect(result.status).toBe('cancelled');
  });

  it('rejects a workspace result whose internal authorization target differs from the bound workspace', async () => {
    const event = { sequence: 1, type: 'home.tool.requested' as const, requestId: 'request-1', sessionId: 'session-1', name: 'home_list_tasks', args: { limit: 1 } };
    const { useCase, runtime } = setup({
      events: [event], scope: { kind: 'workspace', workspaceId: PROJECT }, revisions: { home: '4', workspace: '9' },
      handlerResult: { kind: 'immediate', authorizationProjectId: OWNER, result: { outcome: 'shared', data: { items: [] } } }
    });

    await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(runtime.sendToolResult).not.toHaveBeenCalled();
  });
});
