import { InvokeSkillUseCase } from '@/modules/skills/use-cases/invoke-skill';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const SKILL_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

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
