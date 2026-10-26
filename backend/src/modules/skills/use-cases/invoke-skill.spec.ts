import { InvokeSkillUseCase, skillInvocationFingerprint } from '@/modules/skills/use-cases/invoke-skill';
import { validateSkillDraft } from '@/modules/skills/domain/skill-validation';
import type { SkillInvocation } from '@/modules/skills/domain/skill-invocation-types';
import { SubmitHomeTurnUseCase } from '@/modules/home-assistant/use-cases/submit-home-turn';
import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import type { ISkillRepository } from '@/modules/skills/repositories/skill-repository';
import type { ISkillInvocationRepository } from '@/modules/skills/repositories/skill-invocation-repository';
import { MAX_SKILL_MESSAGE_CHARACTERS, makeSkillMessage } from '@/modules/skills/domain/skill-invocation-message';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const SKILL_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

describe('bounded skill prompt composition through the Home submission boundary', () => {
  it.each([false, true])('accepts exact maximum valid fields without truncation (resumed claim: %s)', async (resumed) => {
    const revisionId = '44444444-4444-4444-8444-444444444444';
    const invocationId = '55555555-5555-4555-8555-555555555555';
    const draft = validateSkillDraft({ workspaceId: null, title: 'Title '.repeat(20).slice(0, 119) + '!',
      instructions: 'Read tasks.\n'.repeat(1500).slice(0, 15_999) + '!', declaredTools: ['home_task_read'], enabled: true });
    expect(draft.title).toHaveLength(120);
    expect(Buffer.byteLength(draft.instructions)).toBe(16_000);
    const request = 'a'.repeat(20_000);
    const invocation = { id: invocationId, ownerId: OWNER_ID, conversationId: CONVERSATION_ID, skillId: SKILL_ID,
      skillRevisionId: revisionId, skillVersion: 1, title: draft.title, instructions: draft.instructions,
      contextRevisions: [], state: 'claimed', turnId: null,
      requestFingerprint: skillInvocationFingerprint({ conversationId: CONVERSATION_ID, skillId: SKILL_ID,
        skillRevisionId: revisionId, skillVersion: 1, request, contextRevisions: [] }) } as unknown as SkillInvocation;
    const savedMessages: string[] = [];
    const conversations = {
      findForOwner: async () => ({ id: CONVERSATION_ID, ownerId: OWNER_ID, scope: { kind: 'home' } }),
      submitTurn: jest.fn(async ({ message }: { message: string }) => {
        savedMessages.push(message);
        return { turn: { id: 'turn', skillInvocationId: invocationId, status: 'unsupported' }, message: { content: message }, replayed: false };
      })
    } as unknown as IHomeConversationRepository;
    const invocations = { findByRequestKey: async () => resumed ? invocation : null,
      claim: async () => invocation, updateState: jest.fn(async () => undefined) } as unknown as ISkillInvocationRepository;
    const skills = { findActiveById: async () => ({ ...draft, id: SKILL_ID, revisionId, version: 1 }) } as unknown as ISkillRepository;
    const useCase = new InvokeSkillUseCase(skills, invocations, conversations, new SubmitHomeTurnUseCase(conversations));

    await expect(useCase.execute({ ownerId: OWNER_ID, skillId: SKILL_ID, conversationId: CONVERSATION_ID,
      expectedVersion: 1, requestKey: 'maximum-valid-invocation', request })).resolves.toMatchObject({ invocation: { id: invocationId } });
    expect(savedMessages).toEqual([makeSkillMessage(draft.title, draft.instructions, request)]);
    expect(savedMessages[0]).toHaveLength(MAX_SKILL_MESSAGE_CHARACTERS);
  });

  it('keeps the ordinary Home message limit and rejects oversized trusted composition before persistence', async () => {
    const conversations = { submitTurn: jest.fn() } as unknown as IHomeConversationRepository;
    const submit = new SubmitHomeTurnUseCase(conversations);
    const base = { ownerId: OWNER_ID, conversationId: CONVERSATION_ID, requestKey: 'message-boundary' };
    await expect(submit.execute({ ...base, message: 'a'.repeat(20_001) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    const skillInvocation = { skillId: SKILL_ID, skillRevisionId: SKILL_ID, skillVersion: 1,
      claim: jest.fn(), isCurrent: jest.fn(), updateState: jest.fn() };
    await expect(submit.execute({ ...base, message: 'a'.repeat(MAX_SKILL_MESSAGE_CHARACTERS + 1), skillInvocation }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(conversations.submitTurn).not.toHaveBeenCalled();
  });
});

describe('InvokeSkillUseCase when a workspace removed the skill source', () => {
  it('does not create a replacement claim or dispatch on a replay whose source lookup is unavailable', async () => {
    const invocations = {
      findByRequestKey: jest.fn(async () => null),
      claim: jest.fn(),
      updateState: jest.fn()
    };
    const skills = { findActiveById: jest.fn(async () => null) };
    const conversations = { findForOwner: jest.fn() };
    const submitHomeTurn = { execute: jest.fn() };
    const useCase = new InvokeSkillUseCase(skills as never, invocations as never, conversations as never, submitHomeTurn as never);

    await expect(useCase.execute({
      ownerId: OWNER_ID,
      skillId: SKILL_ID,
      conversationId: CONVERSATION_ID,
      expectedVersion: 1,
      requestKey: 'workspace-delete-replay',
      request: 'Retry the existing run.'
    })).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND', statusCode: 404 });

    expect(invocations.findByRequestKey).toHaveBeenCalledTimes(1);
    expect(invocations.claim).not.toHaveBeenCalled();
    expect(submitHomeTurn.execute).not.toHaveBeenCalled();
  });
});
