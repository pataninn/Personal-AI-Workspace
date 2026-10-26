import { createHash } from 'node:crypto';

import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { SubmitHomeTurnUseCase, TrustedSkillInvocationBinding } from '@/modules/home-assistant/use-cases/submit-home-turn';
import { AppError } from '@/shared/errors/app-error';
import type { SkillContextRevision, SkillInvocation, SkillInvocationResult, SkillInvocationState } from '@/modules/skills/domain/skill-invocation-types';
import { validateSkillVersion } from '@/modules/skills/domain/skill-validation';
import { SKILL_INPUT_LIMITS } from '@/modules/skills/domain/skill-types';
import { makeSkillMessage } from '@/modules/skills/domain/skill-invocation-message';
import type { ISkillInvocationRepository } from '@/modules/skills/repositories/skill-invocation-repository';
import type { ISkillRepository } from '@/modules/skills/repositories/skill-repository';
import type { HomeAutomationFence } from '@/modules/home-assistant/repositories/home-conversation-repository';

export interface TrustedAutomationInvocation {
  readonly fence: HomeAutomationFence;
  isCurrent(): Promise<boolean>;
  heartbeat(): Promise<boolean>;
}

export interface InvokeSkillInput {
  readonly ownerId: string;
  readonly skillId: string;
  readonly conversationId: string;
  readonly expectedVersion: unknown;
  readonly requestKey: unknown;
  readonly request: unknown;
  /** Internal worker-only guard; HTTP routers construct the input without this field. */
  readonly automation?: TrustedAutomationInvocation;
}

export function skillInvocationFingerprint(input: {
  readonly conversationId: string;
  readonly skillId: string;
  readonly skillRevisionId: string;
  readonly skillVersion: number;
  readonly request: string;
  readonly contextRevisions: readonly SkillContextRevision[];
}): string {
  return createHash('sha256').update(JSON.stringify({
    conversationId: input.conversationId,
    skillId: input.skillId,
    skillRevisionId: input.skillRevisionId,
    skillVersion: input.skillVersion,
    request: input.request,
    contextRevisions: input.contextRevisions
  }), 'utf8').digest('hex');
}

export class InvokeSkillUseCase {
  public constructor(
    private readonly skills: ISkillRepository,
    private readonly invocations: ISkillInvocationRepository,
    private readonly conversations: IHomeConversationRepository,
    private readonly submitHomeTurn: SubmitHomeTurnUseCase
  ) {}

  public async execute(input: InvokeSkillInput): Promise<SkillInvocationResult> {
    const expectedVersion = validateSkillVersion(input.expectedVersion);
    const request = validateRequest(input.request);
    const requestKey = validateRequestKey(input.requestKey);
    const requestKeyDigest = createHash('sha256').update(requestKey, 'utf8').digest('hex');
    const existing = await this.invocations.findByRequestKey(input.ownerId, input.conversationId, requestKeyDigest);

    if (existing) {
      const fingerprint = skillInvocationFingerprint({
        conversationId: input.conversationId,
        skillId: input.skillId,
        skillRevisionId: existing.skillRevisionId,
        skillVersion: expectedVersion,
        request,
        contextRevisions: existing.contextRevisions
      });
      if (existing.skillId !== input.skillId || existing.skillVersion !== expectedVersion || existing.requestFingerprint !== fingerprint) {
        throw new AppError('SKILL_IDEMPOTENCY_KEY_REUSED', 409, 'This Idempotency-Key was already used for a different invocation.');
      }
      if (existing.turnId || existing.state !== 'claimed') return await this.resultFor(existing);
      return await this.continueClaim(input, existing, request, requestKeyDigest);
    }

    const skill = await this.skills.findActiveById(input.ownerId, input.skillId);
    if (!skill) throw skillUnavailable();
    if (skill.version !== expectedVersion) throw versionConflict();
    if (!skill.enabled) throw skillUnavailable();
    const conversation = await this.conversations.findForOwner(input.ownerId, input.conversationId);
    if (!conversation) throw skillUnavailable();
    if (skill.workspaceId !== null && (conversation.scope.kind !== 'workspace' || conversation.scope.workspaceId !== skill.workspaceId)) {
      throw skillUnavailable();
    }

    let claimedInvocation: SkillInvocation | undefined;
    const binding: TrustedSkillInvocationBinding = {
      skillId: skill.id,
      skillRevisionId: skill.revisionId,
      skillVersion: skill.version,
      ...(input.automation ? { automationFence: input.automation.fence, heartbeat: input.automation.heartbeat } : {}),
      claim: async (contextRevisions) => {
        const invocation = await this.invocations.claim({
          ownerId: input.ownerId,
          conversationId: input.conversationId,
          skillId: skill.id,
          skillRevisionId: skill.revisionId,
          skillVersion: skill.version,
          requestKeyDigest,
          requestFingerprint: skillInvocationFingerprint({
            conversationId: input.conversationId,
            skillId: skill.id,
            skillRevisionId: skill.revisionId,
            skillVersion: skill.version,
            request,
            contextRevisions
          }),
          contextRevisions
        });
        claimedInvocation = invocation;
        return invocation;
      },
      isCurrent: async () => {
        const current = await this.skills.findActiveById(input.ownerId, skill.id);
        return current !== null && current.enabled && current.version === skill.version && current.revisionId === skill.revisionId
          && (!input.automation || await input.automation.isCurrent());
      },
      updateState: async (state) => {
        if (!claimedInvocation) throw new Error('A skill invocation must be claimed before its state changes.');
        await this.invocations.updateState(input.ownerId, claimedInvocation.id, state);
      }
    };

    const submission = await this.submitHomeTurn.execute({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      requestKey,
      message: makeSkillMessage(skill.title, skill.instructions, request),
      skillInvocation: binding
    });
    if (!claimedInvocation || submission.turn.skillInvocationId !== claimedInvocation.id) {
      throw new Error('The Home turn did not retain its trusted skill invocation binding.');
    }
    return resultFor({ ...claimedInvocation, turnId: submission.turn.id }, submission.turn.status);
  }

  private async continueClaim(
    input: InvokeSkillInput,
    existing: SkillInvocation,
    request: string,
    requestKeyDigest: string
  ): Promise<SkillInvocationResult> {
    const current = await this.skills.findActiveById(input.ownerId, existing.skillId);
    if (!current || !current.enabled || current.version !== existing.skillVersion || current.revisionId !== existing.skillRevisionId) {
      await this.invocations.updateState(input.ownerId, existing.id, 'denied');
      return resultFor({ ...existing, state: 'denied' }, 'unsupported');
    }
    const conversation = await this.conversations.findForOwner(input.ownerId, input.conversationId);
    if (!conversation || (current.workspaceId !== null
      && (conversation.scope.kind !== 'workspace' || conversation.scope.workspaceId !== current.workspaceId))) {
      await this.invocations.updateState(input.ownerId, existing.id, 'denied');
      return resultFor({ ...existing, state: 'denied' }, 'unsupported');
    }
    const binding: TrustedSkillInvocationBinding = {
      skillId: existing.skillId,
      skillRevisionId: existing.skillRevisionId,
      skillVersion: existing.skillVersion,
      ...(input.automation ? { automationFence: input.automation.fence, heartbeat: input.automation.heartbeat } : {}),
      claim: async (contextRevisions) => await this.invocations.claim({
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        skillId: existing.skillId,
        skillRevisionId: existing.skillRevisionId,
        skillVersion: existing.skillVersion,
        requestKeyDigest,
        requestFingerprint: skillInvocationFingerprint({
          conversationId: input.conversationId,
          skillId: existing.skillId,
          skillRevisionId: existing.skillRevisionId,
          skillVersion: existing.skillVersion,
          request,
          contextRevisions
        }),
        contextRevisions
      }),
      isCurrent: async () => {
        const latest = await this.skills.findActiveById(input.ownerId, existing.skillId);
        return latest !== null && latest.enabled && latest.version === existing.skillVersion && latest.revisionId === existing.skillRevisionId
          && (!input.automation || await input.automation.isCurrent());
      },
      updateState: async (state) => { await this.invocations.updateState(input.ownerId, existing.id, state); }
    };
    const submission = await this.submitHomeTurn.execute({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      requestKey: validateRequestKey(input.requestKey),
      message: makeSkillMessage(existing.title, existing.instructions, request),
      skillInvocation: binding
    });
    if (submission.turn.skillInvocationId !== existing.id) throw new Error('The Home turn did not retain its trusted skill invocation binding.');
    return resultFor({ ...existing, turnId: submission.turn.id }, submission.turn.status);
  }

  private async resultFor(invocation: SkillInvocation): Promise<SkillInvocationResult> {
    if (!invocation.turnId) return resultFor(invocation, invocation.state);
    const turn = await this.conversations.findTurnForOwner(invocation.ownerId, invocation.conversationId, invocation.turnId);
    return resultFor(invocation, turn?.status ?? invocation.state);
  }
}

function resultFor(invocation: SkillInvocation, state: string): SkillInvocationResult {
  return {
    invocation: {
      id: invocation.id,
      skillId: invocation.skillId,
      skillVersion: invocation.skillVersion,
      conversationId: invocation.conversationId,
      turnId: invocation.turnId,
      contextRevisions: invocation.contextRevisions,
      state
    }
  };
}

function validateRequest(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > SKILL_INPUT_LIMITS.requestCharacters) {
    throw new AppError('VALIDATION_ERROR', 400, 'The skill invocation request is invalid.', [{ field: 'request', message: 'Enter a non-empty request no longer than 20000 characters.' }]);
  }
  return value.trim();
}

function validateRequestKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{8,128}$/u.test(value)) {
    throw new AppError('VALIDATION_ERROR', 400, 'A valid Idempotency-Key is required.');
  }
  return value;
}

function skillUnavailable(): AppError {
  return new AppError('SKILL_NOT_FOUND', 404, 'The skill is unavailable.');
}

function versionConflict(): AppError {
  return new AppError('SKILL_VERSION_CONFLICT', 409, 'The skill changed. Refresh it before invoking.');
}
