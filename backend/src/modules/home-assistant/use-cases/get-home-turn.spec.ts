import type { HomeConsentDisclosureDescriptor, HomeConversation, HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import type { IHomePlanningToolRequestHandler } from '@/modules/home-assistant/repositories/home-planning-tool-request-handler';
import type { HomeToolResultConsentGate } from '@/modules/home-assistant/use-cases/home-tool-result-consent-gate';
import { GetHomeTurnUseCase } from '@/modules/home-assistant/use-cases/get-home-turn';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-16T00:00:00.000Z');

function makeTurn(status: HomeTurn['status']): HomeTurn {
  return { id: TURN, ownerId: OWNER, conversationId: CONVERSATION, sequence: 1, requestKey: 'submit-1', status, createdAt: NOW, updatedAt: NOW };
}

const conversation: HomeConversation = {
  id: CONVERSATION, ownerId: OWNER, scope: { kind: 'home' }, title: 'Home', lastEventSequence: 1,
  lastActivityAt: NOW, createdAt: NOW, updatedAt: NOW
};

function setup(options: { readonly pollStatus?: 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'; readonly sendAccepted?: boolean; readonly fixtureRequest?: boolean; readonly injectHandler?: boolean } = {}) {
  let status: HomeTurn['status'] = 'running';
  const conversations = {
    findForOwner: jest.fn(async () => conversation),
    findTurnForOwner: jest.fn(async () => makeTurn(status)),
    completeTurnWithAssistant: jest.fn(async ({ status: nextStatus }: { status: 'completed' | 'partial' }) => {
      status = nextStatus;
      return makeTurn(nextStatus);
    }),
    updateTurnStatus: jest.fn(async ({ status: nextStatus }: { status: 'failed' | 'cancelled' | 'unknown' }) => {
      status = nextStatus;
      return makeTurn(nextStatus);
    })
  };
  const runtime = {
    poll: jest.fn(async () => ({
      status: options.pollStatus ?? 'completed',
      events: [
        { sequence: 1, type: 'assistant.delta' as const, text: 'Plan: password=secret-value' },
        { sequence: 2, type: 'home.tool.requested' as const, requestId: 'fixture-request-1', sessionId: 'fixture-session', name: 'planning_fixture_read', args: options.fixtureRequest ? {} : { detail: 'private' } }
      ],
      nextCursor: 2, hasMore: false
    })),
    sendToolResult: jest.fn(async () => ({ accepted: options.sendAccepted ?? true })),
    delete: jest.fn(async () => undefined)
  };
  const disclosure: HomeConsentDisclosureDescriptor = {
    disclosureId: '44444444-4444-4444-8444-444444444444', phase: 'tool_result',
    provider: { profile: 'nebius-token-factory', name: 'Nebius Token Factory', model: 'test-model' },
    scope: { kind: 'home' }, categories: ['task_metadata'], itemCount: 1, byteLimit: 40
  };
  const toolResults = { request: jest.fn(async () => disclosure) };
  const toolRequestHandler = {
    resolve: jest.fn(async (input: { readonly name: string; readonly args: Readonly<Record<string, unknown>> }) => (
      options.fixtureRequest && input.name === 'planning_fixture_read' && Object.keys(input.args).length === 0
        ? { scope: { kind: 'home' as const }, categories: ['task_metadata' as const], itemCount: 1, data: { fixture: 'synthetic-read-only' } }
        : null
    ))
  };
  const useCase = new GetHomeTurnUseCase(
    conversations as unknown as IHomeConversationRepository,
    runtime as unknown as IHomePlanningRuntime,
    toolResults as unknown as HomeToolResultConsentGate,
    options.injectHandler ? toolRequestHandler as unknown as IHomePlanningToolRequestHandler : undefined
  );
  return { useCase, conversations, runtime, toolResults, toolRequestHandler };
}

describe('GetHomeTurnUseCase', () => {
  it('redacts provider text, denies unsupported tool requests without their arguments, then stores the bounded terminal reply', async () => {
    const { useCase, conversations, runtime } = setup();

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(runtime.sendToolResult).toHaveBeenCalledWith({
      turnId: TURN, requestId: 'fixture-request-1', result: { outcome: 'denied', code: 'CONSENT_DENIED' }
    });
    expect(conversations.completeTurnWithAssistant).toHaveBeenCalledWith({
      ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN,
      content: 'Plan: password=[REDACTED]', status: 'completed'
    });
    expect(result.status).toBe('completed');
    expect(runtime.delete).toHaveBeenCalledWith(TURN);
  });

  it('fails closed when a requested denial cannot be delivered', async () => {
    const { useCase, conversations, runtime } = setup({ sendAccepted: false });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(conversations.updateTurnStatus).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, status: 'unknown' });
    expect(conversations.completeTurnWithAssistant).not.toHaveBeenCalled();
    expect(result.status).toBe('unknown');
    expect(runtime.delete).not.toHaveBeenCalled();
  });

  it('persists a disclosure for the one synthetic fixture and pauses polling before any result egress', async () => {
    const { useCase, conversations, runtime, toolResults, toolRequestHandler } = setup({ pollStatus: 'running', fixtureRequest: true, injectHandler: true });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(toolResults.request).toHaveBeenCalledWith({
      ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, requestId: 'fixture-request-1',
      scope: { kind: 'home' }, categories: ['task_metadata'], itemCount: 1, data: { fixture: 'synthetic-read-only' }
    });
    expect(toolRequestHandler.resolve).toHaveBeenCalledWith({
      ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, requestId: 'fixture-request-1',
      name: 'planning_fixture_read', args: {}, scope: { kind: 'home' }
    });
    expect(runtime.sendToolResult).not.toHaveBeenCalled();
    expect(conversations.completeTurnWithAssistant).not.toHaveBeenCalled();
    expect(result.status).toBe('running');
  });

  it('keeps the production default deny-all when no Task 4.2 handler is injected', async () => {
    const { useCase, runtime, toolResults } = setup({ pollStatus: 'running', fixtureRequest: true });

    await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });

    expect(toolResults.request).not.toHaveBeenCalled();
    expect(runtime.sendToolResult).toHaveBeenCalledWith({
      turnId: TURN, requestId: 'fixture-request-1', result: { outcome: 'denied', code: 'CONSENT_DENIED' }
    });
  });

  it('does not poll a turn for another conversation owner', async () => {
    const { runtime } = setup();
    const foreign = {
      findForOwner: jest.fn(async () => null),
      findTurnForOwner: jest.fn(async () => makeTurn('running'))
    };
    const scoped = new GetHomeTurnUseCase(foreign as unknown as IHomeConversationRepository, runtime as unknown as IHomePlanningRuntime);

    await expect(scoped.execute({ ownerId: '99999999-9999-4999-8999-999999999999', conversationId: CONVERSATION, turnId: TURN })).rejects.toThrow();
    expect(runtime.poll).not.toHaveBeenCalled();
  });
});
