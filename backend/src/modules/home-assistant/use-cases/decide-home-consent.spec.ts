import { createHash } from 'node:crypto';

import type { HomeConsentDecisionResult, HomeConsentDisclosureRecord, HomeMessage, HomeTurn } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomePlanningProvider, IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import { DecideHomeConsentUseCase } from '@/modules/home-assistant/use-cases/decide-home-consent';
import type { PendingHomeToolResult, HomeToolResultConsentGate } from '@/modules/home-assistant/use-cases/home-tool-result-consent-gate';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';
const INITIAL_DISCLOSURE = '44444444-4444-4444-8444-444444444444';
const TOOL_DISCLOSURE = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-16T00:00:00.000Z');

const provider: HomePlanningProvider = { profile: 'nebius-token-factory', model: 'test-model', endpoint: 'https://example.invalid/v1' };

function turn(status: HomeTurn['status'] = 'pending'): HomeTurn {
  return {
    id: TURN, ownerId: OWNER, conversationId: CONVERSATION, sequence: 1, requestKey: 'submit-1', status,
    homePolicyRevision: null, workspacePolicyRevision: null, createdAt: NOW, updatedAt: NOW
  };
}

function disclosure(phase: 'initial' | 'tool_result', decision: HomeConsentDisclosureRecord['decision'], deliveryState: HomeConsentDisclosureRecord['deliveryState']): HomeConsentDisclosureRecord {
  return {
    disclosureId: phase === 'initial' ? INITIAL_DISCLOSURE : TOOL_DISCLOSURE,
    ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, phase,
    providerProfile: provider.profile, providerName: 'Nebius Token Factory', model: provider.model,
    scope: { kind: 'home' }, categories: phase === 'initial' ? ['current_message'] : ['task_metadata'],
    itemCount: 1, byteLimit: phase === 'initial' ? 262144 : 4096, runtimeRequestId: phase === 'tool_result' ? 'tool_request_1' : null,
    resultFingerprint: phase === 'tool_result' ? fingerprint('{"task":"safe"}') : null,
    decision, deliveryState, createdAt: NOW, updatedAt: NOW
  };
}

function message(content = 'Make a plan.'): HomeMessage {
  return { id: '66666666-6666-4666-8666-666666666666', ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, sequence: 1, role: 'user', content, createdAt: NOW };
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function setup(options: {
  readonly result?: HomeConsentDecisionResult;
  readonly currentTurn?: HomeTurn;
  readonly currentDisclosure?: HomeConsentDisclosureRecord;
  readonly currentMessage?: HomeMessage;
  readonly priorMessages?: readonly HomeMessage[];
  readonly start?: { readonly outcome: 'accepted' | 'unavailable' | 'unknown'; readonly code?: 'PLANNING_RUNTIME_UNAVAILABLE' | 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' };
  readonly sendAccepted?: boolean;
  readonly pending?: PendingHomeToolResult | null;
} = {}) {
  const chosenDisclosure = options.currentDisclosure ?? disclosure('initial', 'allow', 'starting');
  const chosenTurn = options.currentTurn ?? turn('pending');
  const result = options.result ?? { turn: chosenTurn, disclosure: chosenDisclosure, replayed: false };
  const conversations = {
    decideConsent: jest.fn(async () => result),
    findTurnForOwner: jest.fn(async () => options.currentTurn ?? turn(chosenDisclosure.phase === 'tool_result' ? 'running' : 'pending')),
    findConsentDisclosure: jest.fn(async () => options.currentDisclosure ?? chosenDisclosure),
    findUserMessageForTurn: jest.fn(async () => options.currentMessage ?? message()),
    findForOwner: jest.fn(async () => ({ scope: { kind: 'home' as const } })),
    listMessagesForOwner: jest.fn(async () => ({ messages: options.priorMessages ?? [], nextBeforeSequence: null })),
    updateConsentDelivery: jest.fn(async ({ deliveryState }: { deliveryState: 'accepted' | 'unavailable' | 'unknown' }) => turn(deliveryState === 'accepted' ? 'running' : deliveryState === 'unavailable' ? 'unsupported' : 'unknown')),
    updateToolResultDelivery: jest.fn(async ({ deliveryState }: { deliveryState: 'accepted' | 'unknown' }) => turn(deliveryState === 'accepted' ? 'running' : 'unknown'))
  };
  const runtime = {
    start: jest.fn(async () => options.start ?? { outcome: 'accepted' as const }),
    sendToolResult: jest.fn(async () => ({ accepted: options.sendAccepted ?? true }))
  };
  const toolResults = { take: jest.fn(() => options.pending ?? null) };
  const useCase = new DecideHomeConsentUseCase(
    conversations as unknown as IHomeConversationRepository,
    runtime as unknown as IHomePlanningRuntime,
    provider,
    toolResults as unknown as HomeToolResultConsentGate
  );
  return { useCase, conversations, runtime, toolResults };
}

describe('DecideHomeConsentUseCase', () => {
  it('starts only after initial allow and sends the redacted current message with its role label', async () => {
    const { useCase, runtime, conversations } = setup({ currentMessage: message('api_key=top-secret Make a plan.') });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, disclosureId: INITIAL_DISCLOSURE, decision: 'allow' });

    expect(runtime.start).toHaveBeenCalledWith({ turnId: TURN, prompt: 'User: api_key=[REDACTED] Make a plan.', provider });
    expect(result).toMatchObject({ turn: { status: 'running' }, execution: { state: 'running' } });
    expect(conversations.updateConsentDelivery).toHaveBeenCalledWith(expect.objectContaining({ deliveryState: 'accepted' }));
  });

  it('reconstructs the owner-scoped transcript before the current message sequence', async () => {
    const priorMessages: HomeMessage[] = [
      { ...message('Earlier request.'), id: 'prior-user', sequence: 1, turnId: 'prior-turn' },
      { ...message('Earlier answer.'), id: 'prior-assistant', sequence: 2, turnId: 'prior-turn', role: 'assistant' }
    ];
    const currentMessage = { ...message('Continue.'), sequence: 3 };
    const savedDisclosure = { ...disclosure('initial', 'allow', 'starting'), categories: ['current_message', 'bounded_home_history'] as const, itemCount: 3 };
    const { useCase, runtime, conversations } = setup({ currentMessage, currentDisclosure: savedDisclosure, priorMessages });

    await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, disclosureId: INITIAL_DISCLOSURE, decision: 'allow' });

    expect(runtime.start).toHaveBeenCalledWith({
      turnId: TURN,
      prompt: 'User: Earlier request.\n\nAssistant: Earlier answer.\n\nUser: Continue.',
      provider
    });
    expect(conversations.listMessagesForOwner).toHaveBeenCalledWith({
      ownerId: OWNER, conversationId: CONVERSATION, beforeSequence: 3, limit: 8, transcriptOnly: true
    });
  });

  it('does not send context when the rebuilt transcript differs from consent metadata', async () => {
    const priorMessages = [{ ...message('Earlier request.'), sequence: 1 }];
    const { useCase, runtime, conversations } = setup({
      currentMessage: { ...message('Continue.'), sequence: 2 },
      priorMessages
    });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, disclosureId: INITIAL_DISCLOSURE, decision: 'allow' });

    expect(runtime.start).not.toHaveBeenCalled();
    expect(conversations.updateConsentDelivery).toHaveBeenCalledWith(expect.objectContaining({ deliveryState: 'unavailable' }));
    expect(result.execution).toMatchObject({ state: 'unsupported', code: 'PLANNING_RUNTIME_UNAVAILABLE' });
  });

  it('denies initial consent without creating a provider run', async () => {
    const { useCase, runtime } = setup({
      result: { turn: turn('cancelled'), disclosure: disclosure('initial', 'deny', 'not_required'), replayed: false }
    });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, disclosureId: INITIAL_DISCLOSURE, decision: 'deny' });

    expect(runtime.start).not.toHaveBeenCalled();
    expect(result.execution).toEqual({ state: 'cancelled' });
  });

  it('preserves provider unavailability and uncertain starts as distinct terminal outcomes', async () => {
    const unavailable = setup({ start: { outcome: 'unavailable', code: 'PLANNING_RUNTIME_UNAVAILABLE' } });
    const unavailableResult = await unavailable.useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, disclosureId: INITIAL_DISCLOSURE, decision: 'allow' });
    expect(unavailableResult).toMatchObject({ turn: { status: 'unsupported' }, execution: { state: 'unsupported', code: 'PLANNING_RUNTIME_UNAVAILABLE' } });

    const uncertain = setup({ start: { outcome: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' } });
    const uncertainResult = await uncertain.useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, disclosureId: INITIAL_DISCLOSURE, decision: 'allow' });
    expect(uncertainResult).toMatchObject({ turn: { status: 'unknown' }, execution: { state: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' } });
  });

  it('does not re-create a provider run when the same decision is replayed', async () => {
    const savedDisclosure = disclosure('initial', 'allow', 'accepted');
    const { useCase, runtime } = setup({
      result: { turn: turn('running'), disclosure: savedDisclosure, replayed: true },
      currentTurn: turn('running'), currentDisclosure: savedDisclosure
    });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, disclosureId: INITIAL_DISCLOSURE, decision: 'allow' });

    expect(runtime.start).not.toHaveBeenCalled();
    expect(result.replayed).toBe(true);
    expect(result.execution).toEqual({ state: 'running' });
  });

  it('sends only the generic denial for a denied dynamic result', async () => {
    const savedDisclosure = disclosure('tool_result', 'deny', 'not_required');
    const { useCase, runtime, conversations, toolResults } = setup({
      result: { turn: turn('running'), disclosure: savedDisclosure, replayed: false },
      currentTurn: turn('running'), currentDisclosure: savedDisclosure
    });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, disclosureId: TOOL_DISCLOSURE, decision: 'deny' });

    expect(runtime.sendToolResult).toHaveBeenCalledWith({ turnId: TURN, requestId: 'tool_request_1', result: { outcome: 'denied', code: 'CONSENT_DENIED' } });
    expect(toolResults.take).toHaveBeenCalledWith(TOOL_DISCLOSURE);
    expect(conversations.updateToolResultDelivery).toHaveBeenCalledWith(expect.objectContaining({ deliveryState: 'accepted' }));
    expect(result.execution).toEqual({ state: 'resumed' });
  });

  it('shares only a matching, process-local, bounded result after a dynamic allow', async () => {
    const savedDisclosure = disclosure('tool_result', 'allow', 'starting');
    const safeData = { task: 'safe' };
    const pending: PendingHomeToolResult = {
      requestId: 'tool_request_1', data: safeData, fingerprint: fingerprint(JSON.stringify(safeData)), byteLimit: 4096,
      categories: ['task_metadata'], itemCount: 1, scope: { kind: 'home' }
    };
    const { useCase, runtime } = setup({
      result: { turn: turn('running'), disclosure: savedDisclosure, replayed: false },
      currentTurn: turn('running'), currentDisclosure: savedDisclosure, pending
    });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, disclosureId: TOOL_DISCLOSURE, decision: 'allow' });

    expect(runtime.sendToolResult).toHaveBeenCalledWith({ turnId: TURN, requestId: 'tool_request_1', result: { outcome: 'shared', data: safeData } });
    expect(result.execution).toEqual({ state: 'resumed' });
  });
});
