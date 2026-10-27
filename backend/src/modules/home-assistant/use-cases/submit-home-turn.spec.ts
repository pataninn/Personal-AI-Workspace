import type { AssistantExecutionAuthorization } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import type { AssistantScopePolicy } from '@/modules/assistant-policy/domain/assistant-scope-policy';
import type { HomeConversation, HomeMessage, HomeTurn, HomeTurnSubmission } from '@/modules/home-assistant/domain/home-conversation-types';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomePlanningProvider, IHomePlanningRuntime, StartHomePlanningRunResult, PollHomePlanningRunResult, CancelHomePlanningRunResult } from '@/modules/home-assistant/repositories/home-planning-runtime';
import type { IHomeProjectMemoryContextReader } from '@/modules/home-assistant/repositories/home-project-memory-context-reader';
import { SubmitHomeTurnUseCase, type HomeTurnRuntimeConfiguration } from '@/modules/home-assistant/use-cases/submit-home-turn';
import { HermesHomePlanningRuntime } from '@/infrastructure/hermes/hermes-home-planning-runtime';
import { ProcessHomeTurnUseCase } from '@/modules/home-assistant/use-cases/process-home-turn';
import type { HermesBridgeClient } from '@/infrastructure/hermes/hermes-bridge-client';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const TURN = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-19T00:00:00.000Z');
const provider: HomePlanningProvider = { profile: 'nvidia-hosted-nim', model: 'test-model', endpoint: 'https://provider.invalid' };

function turn(status: HomeTurn['status'], homePolicyRevision: string | null = '4', workspacePolicyRevision: string | null = null): HomeTurn {
  return {
    id: TURN, ownerId: OWNER, conversationId: CONVERSATION, sequence: 1, requestKey: 'request-1', status,
    homePolicyRevision, workspacePolicyRevision, createdAt: NOW, updatedAt: NOW
  };
}

const conversation: HomeConversation = {
  id: CONVERSATION, ownerId: OWNER, scope: { kind: 'home' }, title: 'Home', lastEventSequence: 0,
  lastActivityAt: NOW, createdAt: NOW, updatedAt: NOW
};

function setup(options: {
  readonly replayed?: boolean;
  readonly revision?: string | null;
  readonly startOutcome?: 'accepted' | 'unavailable' | 'unknown';
  readonly policyFailsAt?: number;
  readonly supports?: boolean;
  readonly scope?: HomeConversation['scope'];
  readonly workspacePolicyAllowsProjectFacts?: boolean;
} = {}) {
  let currentStatus: HomeTurn['status'] = options.replayed ? 'running' : 'running';
  let assertions = 0;
  const currentConversation: HomeConversation = { ...conversation, scope: options.scope ?? { kind: 'home' } };
  const workspacePolicyRevision = currentConversation.scope.kind === 'workspace' ? '8' : null;
  const message: HomeMessage = {
    id: '55555555-5555-4555-8555-555555555555', ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN,
    sequence: 1, role: 'user', content: 'Plan my day', createdAt: NOW
  };
  const revision = options.revision === undefined ? '4' : options.revision;
  const submission: HomeTurnSubmission = { turn: turn(currentStatus, revision, workspacePolicyRevision), message, replayed: options.replayed ?? false };
  const conversations = {
    findForOwner: jest.fn(async () => currentConversation),
    submitTurn: jest.fn(async () => submission),
    listMessagesForOwner: jest.fn(async () => ({ messages: [], nextBeforeSequence: null })),
    findTurnForOwner: jest.fn(async (): Promise<HomeTurn | null> => turn(currentStatus, revision, workspacePolicyRevision)),
    updateTurnStatus: jest.fn(async ({ status }: { readonly status: 'unsupported' | 'unknown' | 'cancelled' }) => {
      currentStatus = status;
      return turn(status, revision, workspacePolicyRevision);
    }),
    settleExpiredTurnCancellation: jest.fn(async (): Promise<HomeTurn | null> => null)
  };
  const executionPolicy = {
    assertHome: jest.fn(async () => {
      assertions += 1;
      if (assertions === options.policyFailsAt) throw new Error('policy changed');
      const policies: AssistantScopePolicy[] = [storedPolicy('home', 'home_in_scope_v1')];
      if (currentConversation.scope.kind === 'workspace') {
        policies.push(storedPolicy('project', options.workspacePolicyAllowsProjectFacts === false ? 'home_in_scope_v1' : 'workspace_in_scope_v1'));
      }
      return { policies, effectiveCapabilities: [], revisions: { home: '4', ...(workspacePolicyRevision ? { workspace: workspacePolicyRevision } : {}) } } satisfies AssistantExecutionAuthorization;
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
  const onAccepted = jest.fn();
  const runtimeConfiguration: HomeTurnRuntimeConfiguration = { mode: 'hermes', provider, runtime, onAccepted };
  const projectMemory: jest.Mocked<IHomeProjectMemoryContextReader> = {
    readSelectedFacts: jest.fn(async (_ownerId: string, _projectId: string) => [])
  };
  const useCase = new SubmitHomeTurnUseCase(
    conversations as unknown as IHomeConversationRepository,
    runtimeConfiguration,
    { executionPolicy, providerProfile: provider.profile, model: provider.model },
    projectMemory
  );
  return { useCase, conversations, runtime, executionPolicy, projectMemory, submission, onAccepted };
}

function storedPolicy(scopeKind: AssistantScopePolicy['scopeKind'], policyProfile: AssistantScopePolicy['policyProfile']): AssistantScopePolicy {
  return {
    id: `${scopeKind}-policy`, ownerId: OWNER, scopeKind, projectId: scopeKind === 'home' ? null : PROJECT,
    policyProfile, providerProfile: provider.profile, model: provider.model, enabled: true, revokedAt: null,
    revision: scopeKind === 'home' ? '4' : '8', createdAt: NOW, updatedAt: NOW
  };
}

describe('SubmitHomeTurnUseCase', () => {
  it('queues unknown startup disposal for maintenance without restarting or settling its outcome', async () => {
    const { conversations, runtime, executionPolicy } = setup({ startOutcome: 'unknown' });
    jest.mocked(runtime.cancel).mockResolvedValueOnce({ outcome: 'unknown' });
    const processing = new ProcessHomeTurnUseCase(conversations as unknown as IHomeConversationRepository, runtime);
    const onAccepted = jest.fn();
    const submit = new SubmitHomeTurnUseCase(conversations as unknown as IHomeConversationRepository,
      { mode: 'hermes', provider, runtime, onAccepted, onAbandoned: (input) => processing.queueAbandonedRuntime(input) },
      { executionPolicy, providerProfile: provider.profile, model: provider.model });

    const result = await submit.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'unknown-start', message: 'Plan today' });
    expect(result.execution?.state).toBe('unknown');
    expect(runtime.delete).not.toHaveBeenCalled();
    await processing.drainCleanup();
    expect(runtime.cancel).toHaveBeenCalledTimes(2);
    expect(runtime.delete).toHaveBeenCalledWith(TURN);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('retains successful disposal proof when recording an unknown startup outcome then fails', async () => {
    const { conversations, runtime, executionPolicy } = setup({ startOutcome: 'unknown' });
    conversations.updateTurnStatus.mockRejectedValueOnce(new Error('expired before status persistence'));
    const onAbandoned = jest.fn(async () => true);
    const submit = new SubmitHomeTurnUseCase(conversations as unknown as IHomeConversationRepository,
      { mode: 'hermes', provider, runtime, onAbandoned },
      { executionPolicy, providerProfile: provider.profile, model: provider.model });
    await expect(submit.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'unknown-record', message: 'Plan today' }))
      .rejects.toThrow('expired before status persistence');
    expect(onAbandoned).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel_requested', 'unknown'] as const)('settles a proven no-send %s turn fenced during context loading', async (status) => {
    const { useCase, conversations, runtime } = setup();
    conversations.listMessagesForOwner.mockImplementation(async () => {
      conversations.findTurnForOwner.mockResolvedValue(turn(status));
      return { messages: [], nextBeforeSequence: null };
    });
    conversations.settleExpiredTurnCancellation.mockResolvedValue(turn('cancelled'));

    await expect(useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' }))
      .resolves.toMatchObject({ turn: { status: 'cancelled' } });
    expect(runtime.start).not.toHaveBeenCalled();
    expect(conversations.settleExpiredTurnCancellation).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });
  });

  it('settles a proven no-send expiry even when asynchronous skill denial persistence fails', async () => {
    const { useCase, conversations, runtime, submission } = setup({ policyFailsAt: 2 });
    const invocationId = '66666666-6666-4666-8666-666666666666';
    Object.assign(submission, { turn: { ...submission.turn, skillInvocationId: invocationId } });
    const skillInvocation = {
      skillId: '77777777-7777-4777-8777-777777777777', skillRevisionId: '88888888-8888-4888-8888-888888888888', skillVersion: 1,
      claim: jest.fn(async () => ({ id: invocationId })), isCurrent: jest.fn(async () => true),
      updateState: jest.fn(async () => { throw new Error('expired principal cannot persist skill denial'); })
    };
    conversations.settleExpiredTurnCancellation.mockResolvedValue(turn('cancelled'));

    await expect(useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Skill request', skillInvocation }))
      .rejects.toThrow('expired principal cannot persist skill denial');

    expect(runtime.start).not.toHaveBeenCalled();
    expect(conversations.settleExpiredTurnCancellation).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });
  });

  it('disposes the actual adapter capability when the owner disappears during a pending create', async () => {
    const { conversations, executionPolicy } = setup();
    const actualProvider: HomePlanningProvider = { profile: 'nebius-token-factory', model: 'nvidia/nemotron-3-super-120b-a12b', endpoint: 'https://api.tokenfactory.nebius.com/v1' };
    let resolveCreate: (value: Record<string, unknown>) => void = () => undefined;
    const pending = new Promise<Record<string, unknown>>((resolve) => { resolveCreate = resolve; });
    let enterCreate: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { enterCreate = resolve; });
    const calls = jest.fn(async (operation: string) => {
      if (operation === 'planning-capabilities') return { providerReceiptVersion: 1, providerProfile: actualProvider.profile, model: actualProvider.model, maxOutputTokens: 512 };
      if (operation === 'planning-create') { enterCreate(); return pending; }
      return operation === 'planning-cancel' ? { outcome: 'confirmed' } : { deleted: true };
    });
    const runtime = new HermesHomePlanningRuntime({ call: calls } as unknown as HermesBridgeClient, actualProvider,
      { providerEgressAdmissionEnforced: true, maxOutputTokens: 512 });
    const onAccepted = jest.fn();
    const useCase = new SubmitHomeTurnUseCase(conversations as unknown as IHomeConversationRepository,
      { mode: 'hermes', provider: actualProvider, runtime, onAccepted },
      { executionPolicy, providerProfile: actualProvider.profile, model: actualProvider.model });
    const work = useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });
    await entered;
    conversations.findTurnForOwner.mockResolvedValue(null);
    resolveCreate({ status: 'preparing' });

    await expect(work).rejects.toThrow();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(calls.mock.calls.map(([operation]) => operation)).toEqual(['planning-capabilities', 'planning-create', 'planning-cancel', 'planning-delete']);
    // A deleted adapter entry produces no second bridge delete, proving the capability is not retained.
    await runtime.delete(TURN);
    expect(calls).toHaveBeenCalledTimes(4);
  });

  it.each(['missing', 'read_failure', 'supervisor_failure'] as const)('compensates an accepted runtime when post-start handoff has %s', async (failure) => {
    const { useCase, conversations, runtime, onAccepted } = setup();
    jest.mocked(runtime.start).mockImplementation(async () => {
      if (failure === 'missing') conversations.findTurnForOwner.mockResolvedValue(null);
      if (failure === 'read_failure') conversations.findTurnForOwner.mockRejectedValue(new Error('read unavailable'));
      return { outcome: 'accepted' };
    });
    if (failure === 'supervisor_failure') onAccepted.mockImplementation(() => { throw new Error('supervisor unavailable'); });

    await expect(useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' })).rejects.toThrow();

    expect(runtime.cancel).toHaveBeenCalledWith(TURN);
    expect(runtime.delete).toHaveBeenCalledWith(TURN);
    if (failure !== 'supervisor_failure') expect(onAccepted).not.toHaveBeenCalled();
  });

  it('retains a durable unknown turn when compensation cannot confirm runtime cancellation', async () => {
    const { useCase, conversations, runtime, onAccepted } = setup();
    onAccepted.mockImplementation(() => { throw new Error('supervisor unavailable'); });
    jest.mocked(runtime.cancel).mockResolvedValue({ outcome: 'unknown' });

    await expect(useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' })).rejects.toThrow('supervisor unavailable');

    expect(conversations.updateTurnStatus).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, status: 'unknown' });
    expect(runtime.delete).not.toHaveBeenCalled();
  });

  it('persists the exact policy revisions before starting the runtime once', async () => {
    const { useCase, conversations, runtime, projectMemory, submission, onAccepted } = setup();

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });

    expect(conversations.submitTurn).toHaveBeenCalledWith(expect.objectContaining({
      initialStatus: 'running', homePolicyRevision: '4', workspacePolicyRevision: null
    }));
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN });
    expect(projectMemory.readSelectedFacts).not.toHaveBeenCalled();
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

  it('binds skill invocation identity before dispatch and leaves an unknown handoff terminal on replay', async () => {
    const { useCase, runtime, conversations, submission } = setup({ startOutcome: 'unknown' });
    const invocationId = '66666666-6666-4666-8666-666666666666';
    Object.assign(submission, { turn: { ...submission.turn, skillInvocationId: invocationId } });
    const states: string[] = [];
    const skillInvocation = {
      skillId: '77777777-7777-4777-8777-777777777777',
      skillRevisionId: '88888888-8888-4888-8888-888888888888',
      skillVersion: 1,
      claim: jest.fn(async () => ({ id: invocationId })),
      isCurrent: jest.fn(async () => true),
      updateState: jest.fn(async (state: string) => { states.push(state); })
    };

    const first = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Skill request', skillInvocation });
    Object.assign(submission, { replayed: true });
    const replay = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Skill request', skillInvocation });

    expect(conversations.submitTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({ skillInvocationId: invocationId }));
    expect(conversations.submitTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ skillInvocationId: invocationId }));
    expect(states).toEqual(['dispatching', 'unknown']);
    expect(first.execution).toMatchObject({ state: 'unknown' });
    expect(replay.replayed).toBe(true);
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it('returns an idempotent replay without restarting the persisted turn', async () => {
    const { useCase, runtime, conversations, projectMemory } = setup({ replayed: true, scope: { kind: 'workspace', workspaceId: PROJECT } });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });

    expect(conversations.submitTurn).toHaveBeenCalledTimes(1);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(projectMemory.readSelectedFacts).not.toHaveBeenCalled();
    expect(result.replayed).toBe(true);
  });

  it('uses current selected facts from the persisted workspace scope and revalidates the snapshot before dispatch', async () => {
    const { useCase, conversations, runtime, executionPolicy, projectMemory } = setup({ scope: { kind: 'workspace', workspaceId: PROJECT } });
    projectMemory.readSelectedFacts.mockResolvedValue([{ id: 'fact-1', version: 2, title: 'Language', content: 'Use English.' }]);

    await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });

    expect(conversations.submitTurn).toHaveBeenCalledWith(expect.objectContaining({ homePolicyRevision: '4', workspacePolicyRevision: '8' }));
    expect(executionPolicy.assertHome).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, projectId: PROJECT, homePolicyRevision: '4', workspacePolicyRevision: '8' }));
    expect(projectMemory.readSelectedFacts).toHaveBeenNthCalledWith(1, OWNER, PROJECT);
    expect(projectMemory.readSelectedFacts).toHaveBeenNthCalledWith(2, OWNER, PROJECT);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('Use English.') }));
  });

  it('does not read or include project facts when the stored workspace policy omits that category', async () => {
    const { useCase, runtime, projectMemory } = setup({
      scope: { kind: 'workspace', workspaceId: PROJECT },
      workspacePolicyAllowsProjectFacts: false
    });
    projectMemory.readSelectedFacts.mockResolvedValue([{ id: 'fact-1', version: 2, title: 'Private note', content: 'SAVED_SECRET' }]);

    await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });

    expect(projectMemory.readSelectedFacts).not.toHaveBeenCalled();
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.not.stringContaining('SAVED_SECRET') }));
  });

  it('does not send when selected facts change before the runtime boundary', async () => {
    const { useCase, conversations, runtime, projectMemory } = setup({ scope: { kind: 'workspace', workspaceId: PROJECT } });
    projectMemory.readSelectedFacts
      .mockResolvedValueOnce([{ id: 'fact-1', version: 2, title: 'Language', content: 'Use English.' }])
      .mockResolvedValueOnce([{ id: 'fact-1', version: 3, title: 'Language', content: 'Use French.' }]);

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });

    expect(runtime.start).not.toHaveBeenCalled();
    expect(conversations.updateTurnStatus).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, status: 'unsupported' });
    expect(result.execution).toMatchObject({ state: 'unsupported', code: 'HOME_CONTEXT_UNAVAILABLE' });
  });

  it('fails closed if selected workspace memory cannot be read', async () => {
    const { useCase, conversations, runtime, projectMemory } = setup({ scope: { kind: 'workspace', workspaceId: PROJECT } });
    projectMemory.readSelectedFacts.mockRejectedValue(new Error('database detail must not escape'));

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });

    expect(runtime.start).not.toHaveBeenCalled();
    expect(conversations.updateTurnStatus).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, status: 'unsupported' });
    expect(result.execution).toMatchObject({ state: 'unsupported', code: 'HOME_CONTEXT_UNAVAILABLE' });
  });

  it('blocks legacy idempotent records without policy binding and does not start them', async () => {
    const { useCase, runtime, conversations } = setup({ replayed: true, revision: null });

    const result = await useCase.execute({ ownerId: OWNER, conversationId: CONVERSATION, requestKey: 'request-1', message: 'Plan my day' });

    expect(runtime.start).not.toHaveBeenCalled();
    expect(conversations.updateTurnStatus).toHaveBeenCalledWith({ ownerId: OWNER, conversationId: CONVERSATION, turnId: TURN, status: 'cancelled' });
    expect(result.turn.homePolicyRevision).toBeNull();
  });
});
