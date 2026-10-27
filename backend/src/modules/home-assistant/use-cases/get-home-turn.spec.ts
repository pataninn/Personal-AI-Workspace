import type { IHomeConversationRepository } from '@/modules/home-assistant/repositories/home-conversation-repository';
import { GetHomeTurnUseCase } from '@/modules/home-assistant/use-cases/get-home-turn';

describe('saved Home turn reads', () => {
  it('returns saved running progress using only owner-scoped reads', async () => {
    const turn = { id: 'turn', status: 'running' };
    const repository = { findForOwner: jest.fn(async () => ({})), findTurnForOwner: jest.fn(async () => turn) };
    const useCase = new GetHomeTurnUseCase(repository as unknown as IHomeConversationRepository);
    await expect(useCase.execute({ ownerId: 'owner', conversationId: 'chat', turnId: 'turn' })).resolves.toBe(turn);
    expect(repository.findForOwner).toHaveBeenCalledWith('owner', 'chat');
    expect(repository.findTurnForOwner).toHaveBeenCalledWith('owner', 'chat', 'turn');
  });

  it('does not reveal a turn in a conversation owned by someone else', async () => {
    const repository = { findForOwner: jest.fn(async () => null), findTurnForOwner: jest.fn() };
    const useCase = new GetHomeTurnUseCase(repository as unknown as IHomeConversationRepository);
    await expect(useCase.execute({ ownerId: 'other', conversationId: 'chat', turnId: 'turn' })).rejects.toThrow();
    expect(repository.findTurnForOwner).not.toHaveBeenCalled();
  });
});
