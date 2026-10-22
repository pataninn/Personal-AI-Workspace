import type { AssistantToolCapability } from '@/modules/assistant-policy/domain/assistant-scope-policy';
import type { AssistantExecutionAuthorization, AssertAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import type { HomeConversation, HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import type { IHomePlanningToolRequestHandler } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';
import type { HomePlanningRuntimeEvent } from '@/modules/home-assistant/repositories/home-planning-runtime';
import type { IHomeAutomationSourceRecorder } from '@/modules/home-assistant/repositories/home-automation-source-recorder';
import type { IHomeProviderCreditReceiptHandler } from '@/modules/home-assistant/repositories/home-provider-credit-receipt-handler';
import type { IHomeTurnProviderUsageHistory } from '@/modules/credits/repositories/provider-call-usage-history';
import { HOME_NEBIUS_NEMOTRON_BOUND } from '@/modules/credits/domain/home-provider-credit-bound';
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
  readonly events?: readonly HomePlanningRuntimeEvent[];
  readonly revisions?: { home: string | null; workspace: string | null };
  readonly scope?: HomeConversation['scope'];
  readonly handlerResult?: Awaited<ReturnType<IHomePlanningToolRequestHandler['resolve']>>;
  readonly assertFailsAt?: number;
  readonly sendAccepted?: boolean;
  readonly cancelConfirmed?: boolean;
  readonly initialStatus?: HomeTurn['status'];
  readonly automationOccurrenceId?: string;
  readonly automationSources?: IHomeAutomationSourceRecorder;
  readonly providerCreditReceipts?: IHomeProviderCreditReceiptHandler;
  readonly providerUsageHistory?: IHomeTurnProviderUsageHistory;
  readonly policyProvider?: { readonly profile: string; readonly model: string };
  readonly pollUnknown?: boolean;
  readonly title?: string;
  readonly setGeneratedTitle?: jest.Mock;
} = {}) {
  let status: HomeTurn['status'] = options.initialStatus ?? 'running';
  const revisions = options.revisions ?? { home: '4', workspace: null };
  const conversation = { ...makeConversation(options.scope), ...(options.title ? { title: options.title } : {}) };
  const currentTurn = () => makeTurn(status, revisions, options.automationOccurrenceId);
  const conversations = {
    ...(options.setGeneratedTitle ? { setGeneratedTitle: options.setGeneratedTitle } : {}),    findForOwner: jest.fn(async () => conversation),
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
    poll: jest.fn(async () => ({ status: options.pollUnknown ? 'unknown' as const : 'completed' as const, events, nextCursor: events.length, hasMore: false })),
    sendToolResult: jest.fn(async () => ({ accepted: options.sendAccepted ?? true })),
    sendProviderCreditResult: jest.fn(async () => ({ accepted: options.sendAccepted ?? true })),
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
    {
      executionPolicy: executionPolicy as unknown as Pick<AssertAssistantExecutionPolicyUseCase, 'assertHome'>,
      providerProfile: options.policyProvider?.profile ?? PROVIDER,
      model: options.policyProvider?.model ?? MODEL
    },
    options.automationSources,
    options.providerCreditReceipts,
    options.providerUsageHistory
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

  it('fails a paid Nebius Home turn without an admitted provider call and discards assistant output', async () => {
    const receipts = {
      handle: jest.fn(),
      hasAdmittedCall: jest.fn(() => false),
      markInterrupted: jest.fn(async () => undefined),
      clearTurn: jest.fn()
    };
    const { useCase, conversations, runtime } = setup({
      events: [{ sequence: 1, type: 'assistant.delta', text: 'Unadmitted answer.' }],
      policyProvider: { profile: HOME_NEBIUS_NEMOTRON_BOUND.providerProfile, model: HOME_NEBIUS_NEMOTRON_BOUND.model },
      providerCreditReceipts: receipts as unknown as IHomeProviderCreditReceiptHandler
    });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(receipts.hasAdmittedCall).toHaveBeenCalledWith(TURN);
    expect(conversations.completeTurnWithAssistant).not.toHaveBeenCalled();
    expect(conversations.updateTurnStatus).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, status: 'failed' });
    expect(runtime.delete).toHaveBeenCalledWith(TURN);
    expect(result.status).toBe('failed');
  });

  it('preserves a paid Nebius Home assistant result after a provider call was admitted', async () => {
    const receipts = {
      handle: jest.fn(),
      hasAdmittedCall: jest.fn(() => true),
      markInterrupted: jest.fn(async () => undefined),
      clearTurn: jest.fn()
    };
    const { useCase, conversations } = setup({
      events: [{ sequence: 1, type: 'assistant.delta', text: 'Admitted answer.' }],
      policyProvider: { profile: HOME_NEBIUS_NEMOTRON_BOUND.providerProfile, model: HOME_NEBIUS_NEMOTRON_BOUND.model },
      providerCreditReceipts: receipts as unknown as IHomeProviderCreditReceiptHandler
    });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(conversations.completeTurnWithAssistant).toHaveBeenCalledWith({
      ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, content: 'Admitted answer.', status: 'completed'
    });
    expect(result.status).toBe('completed');
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

  it('records exact Home task revisions under the occurrence lease before sending the read result', async () => {
    const occurrenceId = '77777777-7777-4777-8777-777777777777';
    const event = { sequence: 1, type: 'home.tool.requested' as const, requestId: 'request-1', sessionId: 'session-1', name: 'home_list_tasks', args: { limit: 1 } };
    const sourceRecorder = {
      recordTaskSources: jest.fn(async () => 'recorded' as const),
      markBudgetSkipped: jest.fn(async () => true)
    };
    const { useCase, runtime } = setup({
      events: [event], automationOccurrenceId: occurrenceId,
      scope: { kind: 'workspace', workspaceId: PROJECT }, revisions: { home: '4', workspace: '9' },
      automationSources: sourceRecorder as unknown as IHomeAutomationSourceRecorder,
      handlerResult: {
        kind: 'immediate', result: { outcome: 'shared', data: { items: [{ id: 'task-id', version: 7 }] } },
        taskSources: [{ taskId: '55555555-5555-4555-8555-555555555555', revision: 7 }]
      }
    });
    const guard = { fence: { occurrenceId, leaseToken: 'lease-token', generation: 4 }, isCurrent: jest.fn(async () => true) };

    await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, automationGuard: guard });

    expect(sourceRecorder.recordTaskSources).toHaveBeenCalledWith({
      ownerId: OWNER, fence: guard.fence, sources: [{ taskId: '55555555-5555-4555-8555-555555555555', revision: 7 }]
    });
    expect(sourceRecorder.recordTaskSources.mock.invocationCallOrder[0]!).toBeLessThan(runtime.sendToolResult.mock.invocationCallOrder[0]!);
  });

  it('routes every provider receipt through Credits and returns the admission result to the bridge', async () => {
    const request = {
      operation: 'reserve' as const,
      callId: '88888888-8888-4888-8888-888888888888',
      attemptId: '99999999-9999-4999-8999-999999999999',
      providerProfile: PROVIDER,
      model: MODEL,
      inputTokenUpperBound: 1024,
      inputBounderVersion: 'hermes-json-utf8-v1' as const
    };
    const event = { sequence: 1, type: 'home.provider.credit.requested' as const, requestId: 'credit-1', request };
    const receipts = {
      handle: jest.fn(async () => ({ outcome: 'reserved' as const, reservationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })),
      hasAdmittedCall: jest.fn(() => true),
      markInterrupted: jest.fn(async () => undefined),
      clearTurn: jest.fn()
    };
    const { useCase, runtime } = setup({ providerCreditReceipts: receipts as unknown as IHomeProviderCreditReceiptHandler, events: [event] });

    await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(receipts.handle).toHaveBeenCalledWith({ ownerId: OWNER, turnId: TURN, providerProfile: PROVIDER, model: MODEL, request });
    expect(runtime.sendProviderCreditResult).toHaveBeenCalledWith({
      turnId: TURN, requestId: 'credit-1', result: { outcome: 'reserved', reservationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
    });
  });

  it('marks a confirmed first-call budget denial as a skipped occurrence before acknowledging the bridge', async () => {
    const occurrenceId = '77777777-7777-4777-8777-777777777777';
    const request = {
      operation: 'reserve' as const,
      callId: '88888888-8888-4888-8888-888888888888',
      attemptId: '99999999-9999-4999-8999-999999999999',
      providerProfile: PROVIDER,
      model: MODEL,
      inputTokenUpperBound: 1024,
      inputBounderVersion: 'hermes-json-utf8-v1' as const
    };
    const event = { sequence: 1, type: 'home.provider.credit.requested' as const, requestId: 'credit-1', request };
    const automationSources = {
      recordTaskSources: jest.fn(async () => 'recorded' as const),
      markBudgetSkipped: jest.fn(async () => true)
    };
    const receipts = {
      handle: jest.fn(async () => ({ outcome: 'denied' as const, code: 'BUDGET_EXHAUSTED' as const })),
      hasAdmittedCall: jest.fn(() => false),
      markInterrupted: jest.fn(async () => undefined),
      clearTurn: jest.fn()
    };
    const { useCase, runtime } = setup({
      events: [event], automationOccurrenceId: occurrenceId,
      scope: { kind: 'workspace', workspaceId: PROJECT }, revisions: { home: '4', workspace: '9' },
      automationSources: automationSources as unknown as IHomeAutomationSourceRecorder,
      providerCreditReceipts: receipts as unknown as IHomeProviderCreditReceiptHandler
    });
    const guard = { fence: { occurrenceId, leaseToken: 'lease-token', generation: 4 }, isCurrent: jest.fn(async () => true) };

    await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, automationGuard: guard });

    expect(automationSources.markBudgetSkipped).toHaveBeenCalledWith({ ownerId: OWNER, fence: guard.fence });
    expect(automationSources.markBudgetSkipped.mock.invocationCallOrder[0]!).toBeLessThan(runtime.sendProviderCreditResult.mock.invocationCallOrder[0]!);
    expect(runtime.sendProviderCreditResult).toHaveBeenCalledWith({ turnId: TURN, requestId: 'credit-1', result: { outcome: 'denied', code: 'BUDGET_EXHAUSTED' } });
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

  it('retains in-flight calls as unknown on poll interruption and again after a runtime restart', async () => {
    const firstReceipts = {
      handle: jest.fn(),
      hasAdmittedCall: jest.fn(() => true),
      markInterrupted: jest.fn(async () => undefined),
      clearTurn: jest.fn()
    };
    const running = setup({
      pollUnknown: true,
      providerCreditReceipts: firstReceipts as unknown as IHomeProviderCreditReceiptHandler
    });

    const interrupted = await running.useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(interrupted.status).toBe('unknown');
    expect(firstReceipts.markInterrupted).toHaveBeenCalledWith(OWNER, TURN);
    expect(firstReceipts.clearTurn).toHaveBeenCalledWith(TURN);

    const restartedReceipts = {
      handle: jest.fn(),
      hasAdmittedCall: jest.fn(() => false),
      markInterrupted: jest.fn(async () => undefined),
      clearTurn: jest.fn()
    };
    const usageHistory = {
      getForHomeTurn: jest.fn(async () => ({
        state: 'unknown' as const,
        calls: [{ status: 'unknown' as const, providerProfile: 'p', model: 'm', inputTokens: null, outputTokens: null, chargedUnits: null }]
      }))
    };
    const restarted = setup({
      initialStatus: 'unknown',
      providerCreditReceipts: restartedReceipts as unknown as IHomeProviderCreditReceiptHandler,
      providerUsageHistory: usageHistory
    });

    const stillUnknown = await restarted.useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(restartedReceipts.markInterrupted).toHaveBeenCalledWith(OWNER, TURN);
    expect(usageHistory.getForHomeTurn).toHaveBeenCalledWith(OWNER, TURN);
    expect(restarted.runtime.poll).not.toHaveBeenCalled();
    expect(restartedReceipts.handle).not.toHaveBeenCalled();
    expect(stillUnknown.status).toBe('unknown');
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


it('persists a generated Home chat title while keeping metadata out of the saved answer', async () => {
  const setGeneratedTitle = jest.fn().mockResolvedValue(true);
  const { useCase, conversations } = setup({ title: 'New chat', setGeneratedTitle, events: [
    { sequence: 1, type: 'assistant.delta', text: '<chat_title>Plan tomorrow</chat_title>\nStart with your priorities.' }
  ] });
  await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });
  expect(setGeneratedTitle).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, title: 'Plan tomorrow' });
  expect(conversations.completeTurnWithAssistant).toHaveBeenCalledWith(expect.objectContaining({ content: 'Start with your priorities.' }));
});
