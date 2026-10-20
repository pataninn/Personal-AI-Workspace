import { HomeConversationInputInvalidError, HomeConversationNotFoundError, HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { buildHomePlanningContext, HOME_PLANNING_CONTEXT_LIMITS, type HomePlanningContext, type HomePlanningContextMessage, type HomePlanningProjectFactSnapshot } from '@/modules/home-assistant/domain/home-planning-context';
import type { HomeConversation, HomeConversationScope, HomeTurn, HomeTurnExecution, HomeTurnSubmission } from '@/modules/home-assistant/domain/home-conversation-types';
import type { AssertAssistantExecutionInput, AssistantExecutionAuthorization, AssertAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import { AssistantExecutionUnavailableError } from '@/modules/assistant-policy/domain/assistant-execution-errors';
import { ASSISTANT_POLICY_PROFILES } from '@/modules/assistant-policy/domain/assistant-scope-policy';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomeAutomationFence } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { HomePlanningProvider, IHomePlanningRuntime } from '@/modules/home-assistant/repositories/home-planning-runtime';
import type { IHomeProjectMemoryContextReader } from '@/modules/home-assistant/repositories/home-project-memory-context-reader';
import { assertHomeIdempotencyKey, homeRequestFingerprint } from '@/modules/home-assistant/use-cases/home-conversation-command-helpers';
import { redactEgressText } from '@/shared/egress/redaction';
import type { SkillContextRevision, SkillInvocationState } from '@/modules/skills/domain/skill-invocation-types';

const MAX_INITIAL_PROMPT_BYTES = HOME_PLANNING_CONTEXT_LIMITS.promptBytes;

export interface HomeTurnRuntimeConfiguration {
  readonly mode: 'fake' | 'direct' | 'openshell' | 'hermes';
  readonly runtime?: IHomePlanningRuntime;
  readonly provider: HomePlanningProvider;
}

export interface HomeExecutionPolicyConfiguration {
  readonly executionPolicy: Pick<AssertAssistantExecutionPolicyUseCase, 'assertHome'>;
  readonly providerProfile: string;
  readonly model: string;
}

export interface SubmitHomeTurnCommand {
  readonly ownerId: string;
  readonly conversationId: string;
  readonly requestKey: string;
  readonly message: string;
  /** Trusted server-only binding created by the skills use case; never accepted from HTTP input. */
  readonly skillInvocation?: TrustedSkillInvocationBinding;
}

export interface TrustedSkillInvocationBinding {
  readonly skillId: string;
  readonly skillRevisionId: string;
  readonly skillVersion: number;
  readonly automationFence?: HomeAutomationFence;
  claim(contextRevisions: readonly SkillContextRevision[]): Promise<{ readonly id: string }>;
  isCurrent(): Promise<boolean>;
  heartbeat?(): Promise<boolean>;
  updateState(state: SkillInvocationState): Promise<void>;
}

/** Saves one idempotent turn and starts it only after the current policy and runtime gates pass. */
export class SubmitHomeTurnUseCase {
  public constructor(
    private readonly conversations: IHomeConversationRepository,
    private readonly runtimeConfiguration?: HomeTurnRuntimeConfiguration,
    private readonly policyConfiguration?: HomeExecutionPolicyConfiguration,
    private readonly projectMemory?: IHomeProjectMemoryContextReader
  ) {}

  public async execute(input: SubmitHomeTurnCommand): Promise<HomeTurnSubmission> {
    assertHomeIdempotencyKey(input.requestKey);
    if (input.message.trim().length === 0 || input.message.length > 20000) {
      throw new HomeConversationInputInvalidError('The message must be non-empty and no longer than 20000 characters.');
    }
    const redacted = redactEgressText(input.message);
    if (Buffer.byteLength(redacted, 'utf8') > MAX_INITIAL_PROMPT_BYTES) {
      throw new HomeConversationInputInvalidError('The redacted message exceeds the provider request limit.');
    }

    const runtimeConfiguration = this.runtimeConfiguration;
    const runtime = runtimeConfiguration?.mode === 'hermes' ? runtimeConfiguration.runtime : undefined;
    const policy = this.policyConfiguration;
    if (!runtimeConfiguration || !runtime || !policy || runtimeConfiguration.mode !== 'hermes') {
      if (!input.skillInvocation) {
        return this.conversations.submitTurn({
          ownerId: input.ownerId,
          conversationId: input.conversationId,
          requestKey: input.requestKey,
          requestFingerprint: homeRequestFingerprint({ message: input.message }),
          message: input.message,
          initialStatus: 'unsupported'
        });
      }
      if (!await input.skillInvocation.isCurrent()) throw new HomeConversationInputInvalidError('The skill or scheduled occurrence is no longer current.');
      const invocation = await input.skillInvocation.claim([]);
      const submission = await this.conversations.submitTurn({
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        requestKey: input.requestKey,
        requestFingerprint: skillHomeRequestFingerprint(input.message, input.skillInvocation, []),
        message: input.message,
        initialStatus: 'unsupported',
        skillInvocationId: invocation.id,
        ...(input.skillInvocation.automationFence ? { automationFence: input.skillInvocation.automationFence } : {})
      });
      if (submission.turn.skillInvocationId !== invocation.id) throw new HomeTurnNotFoundError();
      await input.skillInvocation.updateState('denied');
      return submission;
    }
    if (!await supportsPolicyExecution(runtime, policy)) throw new AssistantExecutionUnavailableError();

    const conversation = await this.conversations.findForOwner(input.ownerId, input.conversationId);
    if (!conversation) throw new HomeConversationNotFoundError();
    const authorization = await assertConversationPolicy(policy, input.ownerId, conversation);
    const projectFactsPermitted = permitsProjectFacts(authorization, conversation);
    const revisions = requiredRevisions(conversation.scope, authorization);
    let skillPreflightContext: HomePlanningContext | undefined;
    let skillContextRevisions: readonly SkillContextRevision[] | undefined;
    if (input.skillInvocation) {
      if (!await input.skillInvocation.isCurrent()) throw new HomeConversationInputInvalidError('The skill is no longer enabled at this version.');
      skillPreflightContext = await this.readSkillPlanningContext(input.ownerId, input.conversationId, input.message, conversation, projectFactsPermitted);
      skillContextRevisions = skillContextRevisionsFor(skillPreflightContext);
    }
    const invocation = input.skillInvocation
      ? await input.skillInvocation.claim(skillContextRevisions ?? [])
      : undefined;
    const submission = await this.conversations.submitTurn({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      requestKey: input.requestKey,
      requestFingerprint: input.skillInvocation
        ? skillHomeRequestFingerprint(input.message, input.skillInvocation, skillContextRevisions ?? [])
        : homeRequestFingerprint({ message: input.message }),
      message: input.message,
      initialStatus: 'running',
      homePolicyRevision: revisions.home,
      workspacePolicyRevision: revisions.workspace,
      ...(invocation ? { skillInvocationId: invocation.id } : {}),
      ...(input.skillInvocation?.automationFence ? { automationFence: input.skillInvocation.automationFence } : {})
    });

    if (input.skillInvocation && submission.turn.skillInvocationId !== invocation?.id) throw new HomeTurnNotFoundError();

    if (submission.replayed) {
      return this.replayWithoutRestart(input.ownerId, input.conversationId, submission, runtime);
    }

    let priorMessages: readonly HomePlanningContextMessage[] = [];
    let planningContext: HomePlanningContext;
    try {
      const history = await this.conversations.listMessagesForOwner({
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        beforeSequence: submission.message.sequence,
        limit: HOME_PLANNING_CONTEXT_LIMITS.priorMessages,
        transcriptOnly: true
      });
      if (!history) throw new HomeConversationNotFoundError();
      priorMessages = history.messages.map((message) => ({
        role: message.role,
        content: message.content,
        sourceId: message.id,
        sourceRevision: message.sequence
      }));
      const selectedProjectFacts = projectFactsPermitted
        ? await this.readSelectedProjectFacts(input.ownerId, conversation)
        : [];
      planningContext = buildHomePlanningContext({
        currentMessage: submission.message.content,
        priorMessages,
        selectedProjectFacts
      });
      if (input.skillInvocation && (!sameSkillContextRevisions(skillContextRevisions ?? [], skillContextRevisionsFor(planningContext))
        || !skillPreflightContext
        || !sameProjectMemorySnapshot(skillPreflightContext.selectedProjectFacts, planningContext.selectedProjectFacts))) {
        return this.finishKnownNoSend(input.ownerId, input.conversationId, submission, 'HOME_CONTEXT_UNAVAILABLE', input.skillInvocation);
      }
    } catch {
      return this.finishKnownNoSend(input.ownerId, input.conversationId, submission, 'HOME_CONTEXT_UNAVAILABLE', input.skillInvocation);
    }

    const beforeSend = await this.findCurrentTurn(input.ownerId, input.conversationId, submission.turn.id);
    if (!beforeSend) throw new HomeTurnNotFoundError();
    if (beforeSend.status !== 'running' || !samePolicyBinding(beforeSend, revisions)) {
      return resultWithTurn(submission, beforeSend, executionForTurn(beforeSend));
    }
    try {
      const currentAuthorization = await assertConversationPolicy(policy, input.ownerId, conversation, revisions);
      if (projectFactsPermitted && !permitsProjectFacts(currentAuthorization, conversation)) {
        return this.finishKnownNoSend(input.ownerId, input.conversationId, submission, 'ASSISTANT_EXECUTION_UNAVAILABLE', input.skillInvocation);
      }
    } catch {
      return this.finishKnownNoSend(input.ownerId, input.conversationId, submission, 'ASSISTANT_EXECUTION_UNAVAILABLE', input.skillInvocation);
    }

    const authorizedTurn = await this.findCurrentTurn(input.ownerId, input.conversationId, submission.turn.id);
    if (!authorizedTurn) throw new HomeTurnNotFoundError();
    if (authorizedTurn.status === 'cancel_requested') {
      const turn = await this.updateStatus(input.ownerId, input.conversationId, submission.turn.id, 'cancelled');
      return resultWithTurn(submission, turn, { state: 'cancelled' });
    }
    if (authorizedTurn.status !== 'running' || !samePolicyBinding(authorizedTurn, revisions)) {
      return resultWithTurn(submission, authorizedTurn, executionForTurn(authorizedTurn));
    }

    if (conversation.scope.kind === 'workspace' && projectFactsPermitted) {
      try {
        const latestSelectedProjectFacts = await this.readSelectedProjectFacts(input.ownerId, conversation);
        const latestContext = buildHomePlanningContext({
          currentMessage: submission.message.content,
          priorMessages,
          selectedProjectFacts: latestSelectedProjectFacts
        });
        if (!sameProjectMemorySnapshot(planningContext.selectedProjectFacts, latestContext.selectedProjectFacts)) {
          return this.finishKnownNoSend(input.ownerId, input.conversationId, submission, 'HOME_CONTEXT_UNAVAILABLE', input.skillInvocation);
        }
      } catch {
        return this.finishKnownNoSend(input.ownerId, input.conversationId, submission, 'HOME_CONTEXT_UNAVAILABLE', input.skillInvocation);
      }
    }

    if (input.skillInvocation) {
      await input.skillInvocation.updateState('dispatching');
      if (input.skillInvocation.automationFence && !await input.skillInvocation.heartbeat?.()) {
        return this.finishKnownNoSend(input.ownerId, input.conversationId, submission, 'SCHEDULE_LEASE_LOST', input.skillInvocation);
      }
      if (!await input.skillInvocation.isCurrent()) {
        return this.finishKnownNoSend(input.ownerId, input.conversationId, submission, 'SKILL_NOT_AVAILABLE', input.skillInvocation);
      }
    }

    let outcome: 'accepted' | 'unavailable' | 'unknown';
    try {
      outcome = (await runtime.start({ turnId: submission.turn.id, prompt: planningContext.prompt, provider: runtimeConfiguration.provider })).outcome;
    } catch {
      outcome = 'unknown';
    }
    if (outcome === 'unavailable') {
      return this.finishKnownNoSend(input.ownerId, input.conversationId, submission, 'PLANNING_RUNTIME_UNAVAILABLE', input.skillInvocation);
    }
    if (outcome === 'unknown') {
      if (input.skillInvocation) await input.skillInvocation.updateState('unknown');
      const turn = await this.updateStatus(input.ownerId, input.conversationId, submission.turn.id, 'unknown');
      return resultWithTurn(submission, turn, { state: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' });
    }
    if (input.skillInvocation) await input.skillInvocation.updateState('accepted');

    const afterSend = await this.findCurrentTurn(input.ownerId, input.conversationId, submission.turn.id);
    if (!afterSend) throw new HomeTurnNotFoundError();
    if (afterSend.status === 'cancel_requested') {
      const cancelled = await cancelStartedRun(runtime, afterSend);
      const turn = await this.updateStatus(input.ownerId, input.conversationId, submission.turn.id, cancelled ? 'cancelled' : 'unknown');
      return resultWithTurn(submission, turn, cancelled
        ? { state: 'cancelled' }
        : { state: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' });
    }
    return resultWithTurn(submission, afterSend, executionForTurn(afterSend));
  }

  private async replayWithoutRestart(ownerId: string, conversationId: string, submission: HomeTurnSubmission, runtime: IHomePlanningRuntime): Promise<HomeTurnSubmission> {
    let turn = submission.turn;
    if (turn.homePolicyRevision === null) {
      if (turn.status === 'pending') {
        turn = await this.updateStatus(ownerId, conversationId, turn.id, 'unsupported');
      } else if (turn.status === 'running' || turn.status === 'cancel_requested') {
        const cancelled = await cancelStartedRun(runtime, turn);
        turn = await this.updateStatus(ownerId, conversationId, turn.id, cancelled ? 'cancelled' : 'unknown');
      }
    }
    return withoutLegacyDisclosure(submission, turn, executionForTurn(turn));
  }

  private async findCurrentTurn(ownerId: string, conversationId: string, turnId: string): Promise<HomeTurn | null> {
    return this.conversations.findTurnForOwner(ownerId, conversationId, turnId);
  }

  private async readSelectedProjectFacts(ownerId: string, conversation: HomeConversation): Promise<readonly HomePlanningProjectFactSnapshot[]> {
    if (conversation.scope.kind === 'home') return [];
    if (!this.projectMemory) throw new Error('Workspace memory context is unavailable.');
    return this.projectMemory.readSelectedFacts(ownerId, conversation.scope.workspaceId);
  }

  private async readSkillPlanningContext(
    ownerId: string,
    conversationId: string,
    currentMessage: string,
    conversation: HomeConversation,
    projectFactsPermitted: boolean
  ): Promise<HomePlanningContext> {
    const history = await this.conversations.listMessagesForOwner({
      ownerId,
      conversationId,
      limit: HOME_PLANNING_CONTEXT_LIMITS.priorMessages,
      transcriptOnly: true
    });
    if (!history) throw new HomeConversationNotFoundError();
    const priorMessages: readonly HomePlanningContextMessage[] = history.messages.map((message) => ({
      role: message.role,
      content: message.content,
      sourceId: message.id,
      sourceRevision: message.sequence
    }));
    const selectedProjectFacts = projectFactsPermitted ? await this.readSelectedProjectFacts(ownerId, conversation) : [];
    return buildHomePlanningContext({ currentMessage, priorMessages, selectedProjectFacts });
  }

  private async finishKnownNoSend(
    ownerId: string,
    conversationId: string,
    submission: HomeTurnSubmission,
    code: string,
    skillInvocation?: TrustedSkillInvocationBinding
  ): Promise<HomeTurnSubmission> {
    if (skillInvocation) await skillInvocation.updateState('denied');
    const current = await this.findCurrentTurn(ownerId, conversationId, submission.turn.id);
    if (!current) throw new HomeTurnNotFoundError();
    if (current.status === 'cancel_requested') {
      const cancelled = await this.updateStatus(ownerId, conversationId, current.id, 'cancelled');
      return resultWithTurn(submission, cancelled, { state: 'cancelled' });
    }
    if (current.status === 'running') {
      const unsupported = await this.updateStatus(ownerId, conversationId, current.id, 'unsupported');
      return resultWithTurn(submission, unsupported, { state: 'unsupported', code });
    }
    return resultWithTurn(submission, current, executionForTurn(current));
  }

  private async updateStatus(ownerId: string, conversationId: string, turnId: string, status: 'unsupported' | 'unknown' | 'cancelled'): Promise<HomeTurn> {
    const turn = await this.conversations.updateTurnStatus({ ownerId, conversationId, turnId, status });
    if (!turn) throw new HomeTurnNotFoundError();
    return turn;
  }
}

function skillContextRevisionsFor(context: HomePlanningContext): readonly SkillContextRevision[] {
  const expectedHistoryCount = context.itemCount - 1 - context.selectedProjectFacts.length;
  if (context.historyMessageRevisions.length !== expectedHistoryCount) {
    throw new HomeConversationInputInvalidError('A skill context source could not be bound to a persisted revision.');
  }
  return [
    ...context.historyMessageRevisions.map(({ id, revision }) => ({ kind: 'home_message' as const, id, revision })),
    ...context.selectedProjectFacts.map(({ id, version }) => ({ kind: 'project_fact' as const, id, revision: version }))
  ];
}

function sameSkillContextRevisions(first: readonly SkillContextRevision[], second: readonly SkillContextRevision[]): boolean {
  return first.length === second.length && first.every((revision, index) => {
    const current = second[index];
    return current !== undefined && revision.kind === current.kind && revision.id === current.id && revision.revision === current.revision;
  });
}

function skillHomeRequestFingerprint(
  message: string,
  binding: TrustedSkillInvocationBinding,
  contextRevisions: readonly SkillContextRevision[]
): string {
  return homeRequestFingerprint({
    message,
    skillInvocation: {
      skillId: binding.skillId,
      skillRevisionId: binding.skillRevisionId,
      skillVersion: binding.skillVersion,
      contextRevisions
    }
  });
}

function permitsProjectFacts(authorization: AssistantExecutionAuthorization, conversation: HomeConversation): boolean {
  const scope = conversation.scope;
  if (scope.kind !== 'workspace') return false;
  const workspacePolicy = authorization.policies.find((candidate) => candidate.scopeKind === 'project'
    && candidate.ownerId === conversation.ownerId && candidate.projectId === scope.workspaceId);
  if (!workspacePolicy || !workspacePolicy.enabled || workspacePolicy.revokedAt !== null) return false;
  return ASSISTANT_POLICY_PROFILES[workspacePolicy.policyProfile].contextCategories.includes('project_facts');
}

function sameProjectMemorySnapshot(
  first: HomePlanningContext['selectedProjectFacts'],
  second: HomePlanningContext['selectedProjectFacts']
): boolean {
  return first.length === second.length && first.every((fact, index) => {
    const current = second[index];
    return current !== undefined && fact.id === current.id && fact.version === current.version
      && fact.title === current.title && fact.content === current.content;
  });
}

async function supportsPolicyExecution(runtime: IHomePlanningRuntime, policy: HomeExecutionPolicyConfiguration): Promise<boolean> {
  if (!runtime.supportsPolicyExecution) return false;
  try {
    return await runtime.supportsPolicyExecution({ providerProfile: policy.providerProfile, model: policy.model });
  } catch {
    return false;
  }
}

async function assertConversationPolicy(
  policy: HomeExecutionPolicyConfiguration,
  ownerId: string,
  conversation: HomeConversation,
  binding?: { readonly home: string; readonly workspace: string | null }
): Promise<AssistantExecutionAuthorization> {
  return policy.executionPolicy.assertHome({
    ownerId,
    ...(conversation.scope.kind === 'workspace' ? { projectId: conversation.scope.workspaceId } : {}),
    providerProfile: policy.providerProfile,
    model: policy.model,
    ...(binding ? { homePolicyRevision: binding.home } : {}),
    ...(binding?.workspace ? { workspacePolicyRevision: binding.workspace } : {})
  } satisfies AssertAssistantExecutionInput);
}

function requiredRevisions(scope: HomeConversationScope, authorization: AssistantExecutionAuthorization): { readonly home: string; readonly workspace: string | null } {
  const home = authorization.revisions.home;
  const workspace = scope.kind === 'workspace' ? authorization.revisions.workspace : undefined;
  if (!isRevision(home) || (scope.kind === 'workspace' && !isRevision(workspace))) throw new AssistantExecutionUnavailableError();
  return { home, workspace: workspace ?? null };
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/u.test(value);
}

function samePolicyBinding(turn: HomeTurn, binding: { readonly home: string; readonly workspace: string | null }): boolean {
  return turn.homePolicyRevision === binding.home && turn.workspacePolicyRevision === binding.workspace;
}

async function cancelStartedRun(runtime: IHomePlanningRuntime, turn: HomeTurn): Promise<boolean> {
  try {
    return (await runtime.cancel(turn.id)).outcome === 'confirmed';
  } catch {
    return false;
  }
}

function executionForTurn(turn: HomeTurn): HomeTurnExecution {
  if (turn.status === 'running') return { state: 'running' };
  if (turn.status === 'cancelled' || turn.status === 'cancel_requested') return { state: 'cancelled' };
  if (turn.status === 'unsupported') return { state: 'unsupported', code: 'ASSISTANT_EXECUTION_UNAVAILABLE' };
  return { state: 'unknown', code: 'PLANNING_RUNTIME_OUTCOME_UNKNOWN' };
}

function resultWithTurn(submission: HomeTurnSubmission, turn: HomeTurn, execution: HomeTurnExecution): HomeTurnSubmission {
  return { turn, message: submission.message, replayed: submission.replayed, execution };
}

function withoutLegacyDisclosure(submission: HomeTurnSubmission, turn: HomeTurn, execution: HomeTurnExecution): HomeTurnSubmission {
  return { turn, message: submission.message, replayed: true, execution };
}
