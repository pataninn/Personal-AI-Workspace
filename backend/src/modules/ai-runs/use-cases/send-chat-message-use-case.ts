import type { IProjectChatContextRepository } from '@/modules/ai-runs/repositories/project-chat-context-repository';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import type { CreateAiRunUseCase, DecideEgressUseCase, CreateAiRunOutput } from '@/modules/ai-runs/use-cases/ai-run-use-cases';
import type { StartAiRunUseCase } from '@/modules/ai-runs/use-cases/start-ai-run-use-case';

export interface SendChatMessageInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly request: string;
  readonly idempotencyKey: string;
}

export class SendChatMessageUseCase {
  public constructor(
    private readonly contexts: Pick<IProjectChatContextRepository, 'get'>,
    private readonly facts: IProjectFactRepository,
    private readonly createRun: Pick<CreateAiRunUseCase, 'execute'>,
    private readonly preparePolicyRun: Pick<DecideEgressUseCase, 'preparePolicyAuthorizedRun'>,
    private readonly startRun: Pick<StartAiRunUseCase, 'execute'>
  ) {}

  public async execute(input: SendChatMessageInput): Promise<CreateAiRunOutput> {
    const context = await this.contexts.get(input.ownerId, input.projectId);
    // Deleted facts stop participating without blocking every chat in the project.
    const facts = await this.facts.findActiveByIds(input.ownerId, input.projectId, context.factIds);
    const created = await this.createRun.execute({
      ...input, relativePaths: context.relativePaths, factIds: facts.map((fact) => fact.id),
      includeRecentMessages: context.includeProjectConversations, includeProjectConversations: context.includeProjectConversations
    });
    let run = created.resource;
    if (run.decision === 'policy_authorized') {
      if (run.status === 'staging') {
        run = await this.preparePolicyRun.preparePolicyAuthorizedRun({ ownerId: input.ownerId, runId: run.id });
      }
      if (run.status === 'ready') {
        const started = await this.startRun.execute({
          ownerId: input.ownerId,
          runId: run.id,
          idempotencyKey: `policy-start-${run.id}`
        });
        run = started.resource;
      }
    }
    return { resource: run, replayed: created.replayed };
  }
}
