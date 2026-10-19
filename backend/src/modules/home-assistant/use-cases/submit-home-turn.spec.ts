import type { AssistantExecutionAuthorization } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import type { HomeConversation, HomeMessage, HomeTurn, HomeTurnSubmission } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomePlanningProvider, IHomePlanningRuntime, StartHomePlanningRunResult, PollHomePlanningRunResult, CancelHomePlanningRunResult } from '@/modules/home-assistant/repositories/home-planning-runtime';
import { SubmitHomeTurnUseCase, type HomeTurnRuntimeConfiguration } from '@/modules/home-assistant/use-cases/submit-home-turn';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-19T00:00:00.000Z');
const provider: HomePlanningProvider = { profile: 'nvidia-hosted-nim', model: 'test-model', endpoint: 'https://provider.invalid' };

function turn(status: HomeTurn['status'], homePolicyRevision: string | null = '4'): HomeTurn {
  return {
    id: TURN, ownerId: OWNER, conversationId: CONVERSATION, sequence: 1, requestKey: 'request-1', status,
    homePolicyRevision, workspacePolicyRevision: null, createdAt: NOW, updatedAt: NOW
  };
}

const conversation: HomeConversation = {
  id: CONVERSATION, ownerId: OWNER, scope: { kind: 'home' }, title: 'Home', lastEventSequence: 0,
  lastActivityAt: NOW, createdAt: NOW, updatedAt: NOW
};

function setup(options: { readonly replayed?: boolean; readonly revision?: string | null; readonly startOutcome?: 'accepted' | 'unavailable' | 'unknown'; readonly policyFailsAt?: number; readonly supports?: boolean } = {}) {
  let currentStatus: HomeTurn['status'] = options.replayed ? 'running' : 'running';
  let assertions = 0;
  const message: HomeMessage = {
    id: '55555555-5555-4555-8555-555555555555', ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN,
    sequence: 1, role: 'user', content: 'Plan my day', createdAt: NOW
  };
  const revision = options.revision === undefined ? '4' : options.revision;
  const submission: HomeTurnSubmission = { turn: turn(currentStatus, revision), message, replayed: options.replayed ?? false };
  const conversations = {
    findForOwner: jest.fn(async () => conversation),
    submitTurn: jest.fn(async () => submission),
    listMessagesForOwner: jest.fn(async () => ({ messages: [], nextBeforeSequence: null })),
    findTurnForOwner: jest.fn(async () => turn(currentStatus, revision)),
    updateTurnStatus: jest.fn(async ({ status }: { readonly status: 'unsupported' | 'unknown' | 'cancelled' }) => {
      currentStatus = status;
      return turn(status, revision);
    })
  };
  const executionPolicy = {
    assertHome: jest.fn(async () => {
      assertions += 1;
      if (assertions === options.policyFailsAt) throw new Error('policy changed');
      return { policies: [], effectiveCapabilities: [], revisions: { home: '4' } } satisfies AssistantExecutionAuthorization;
    })
  };
  const runtime: IHomePlanningRuntime = {
    supportsPolicyExecution: jest.fn(async () => options.supports ?? true),
    start: jest.fn(async (): Promise<StartHomePlanningRunResult> => options.startOutcome === 'unavailable'
      ? { outcome: 'unavailable', code: 'PLANNING_RUNTIME_UNAVAILABLE' }
      : options.startOutcome === 'unknown'
        ? { outcome: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' }
        : { outcome: 'accepted' }),
    poll: jest.fn(async (): Promise<PollHomePlanningRunResult> => ({ status: 'running', events: [], nextCursor: 0, hasMore: false })),
    sendToolResult: jest.fn(async () => ({ accepted: true })),
    cancel: jest.fn(async (): Promise<CancelHomePlanningRunResult> => ({ outcome: 'confirmed' })),
    delete: jest.fn(async () => undefined)
  };
  const runtimeConfiguration: HomeTurnRuntimeConfiguration = { mode: 'hermes', provider, runtime };
  const useCase = new SubmitHomeTurnUseCase(
    conversations as unknown as IHomeConversationRepository,
    runtimeConfiguration,
    { executionPolicy, providerProfile: provider.profile, model: provider.model }
  );
  return { useCase, conversations, runtime, executionPolicy, submission };
}

describe('SubmitHomeTurnUseCase', () => {
  it('persists the exact policy revisions before starting the runtime once', async () => {
    const { useCase, conversations, runtime, submission } = setup();

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });

    expect(conversations.submitTurn).toHaveBeenCalledWith(expect.objectContaining({
      initialStatus: 'running', homePolicyRevision: '4', workspacePolicyRevision: null
    }));
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ turn: submission.turn, replayed: false, execution: { state: 'running' } });
  });

  it('does not persist or send when the runtime lacks verified policy execution support', async () => {
    const { useCase, conversations, runtime } = setup({ supports: false });

    await expect(useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' })).rejects.toThrow();

    expect(conversations.submitTurn).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it('does not dispatch after the stored policy changes between admission and send', async () => {
    const { useCase, conversations, runtime } = setup({ policyFailsAt: 2 });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });

    expect(runtime.start).not.toHaveBeenCalled();
    expect(conversations.updateTurnStatus).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, status: 'unsupported' });
    expect(result.execution).toMatchObject({ state: 'unsupported' });
  });

  it('keeps an uncertain provider handoff unknown and never retries it', async () => {
    const { useCase, runtime, conversations } = setup({ startOutcome: 'unknown' });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });

    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(conversations.updateTurnStatus).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, status: 'unknown' });
    expect(result.execution).toMatchObject({ state: 'unknown' });
  });

  it('returns an idempotent replay without restarting the persisted turn', async () => {
    const { useCase, runtime, conversations } = setup({ replayed: true });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });

    expect(conversations.submitTurn).toHaveBeenCalledTimes(1);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(result.replayed).toBe(true);
  });

  it('blocks legacy idempotent records without policy binding and does not start them', async () => {
    const { useCase, runtime, conversations } = setup({ replayed: true, revision: null });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });

    expect(runtime.start).not.toHaveBeenCalled();
    expect(conversations.updateTurnStatus).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, status: 'cancelled' });
    expect(result.turn.homePolicyRevision).toBeNull();
  });
});
