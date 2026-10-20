import type { SkillRunTurnSummary } from '@/modules/skills/domain/skill-run-summary-types';
import type { ISkillInvocationRepository } from '@/modules/skills/repositories/skill-invocation-repository';

export class ListHomeSkillRunSummariesUseCase {
  public constructor(private readonly invocations: ISkillInvocationRepository) {}

  public execute(input: {
    readonly ownerId: string;
    readonly conversationId: string;
    readonly turnIds: readonly string[];
  }): Promise<readonly SkillRunTurnSummary[]> {
    const turnIds = [...new Set(input.turnIds)].slice(0, 100);
    if (turnIds.length === 0) return Promise.resolve([]);
    return this.invocations.listTurnSummaries(input.ownerId, input.conversationId, turnIds);
  }
}
