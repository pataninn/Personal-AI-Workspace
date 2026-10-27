import { ListHomeSkillRunSummariesUseCase } from '@/modules/skills/use-cases/list-home-skill-run-summaries';

describe('ListHomeSkillRunSummariesUseCase', () => {
  it('requests a deduplicated bounded turn set under the supplied owner and conversation', async () => {
    const summaries = [{ turnId: 'turn-1', summary: { title: 'Plan', skillVersion: 1, state: 'accepted' as const, sources: [] } }];
    const listTurnSummaries = jest.fn(async () => summaries);
    const useCase = new ListHomeSkillRunSummariesUseCase({ listTurnSummaries } as never);

    await expect(useCase.execute({ ownerId: 'owner-1', conversationId: 'conversation-1', turnIds: ['turn-1', 'turn-1'] })).resolves.toEqual(summaries);
    expect(listTurnSummaries).toHaveBeenCalledWith('owner-1', 'conversation-1', ['turn-1']);
  });

  it('does not query the repository for an empty turn set', async () => {
    const listTurnSummaries = jest.fn();
    const useCase = new ListHomeSkillRunSummariesUseCase({ listTurnSummaries } as never);

    await expect(useCase.execute({ ownerId: 'owner-1', conversationId: 'conversation-1', turnIds: [] })).resolves.toEqual([]);
    expect(listTurnSummaries).not.toHaveBeenCalled();
  });
});
