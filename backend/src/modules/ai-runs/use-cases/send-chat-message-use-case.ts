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
    private readonly contexts: IProjectChatContextRepository,
    private readonly facts: IProjectFactRepository,
    private readonly createRun: Pick<CreateAiRunUseCase, 'execute'>,
    private readonly decideEgress: Pick<DecideEgressUseCase, 'execute'>,
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
    if (run.decision === 'pending' && run.status === 'pending_approval') {
      // Sending a chat message authorizes transmission of the project's saved context.
      run = await this.decideEgress.execute({ ownerId: input.ownerId, runId: run.id, manifestHash: run.manifest.manifestHash,
        decision: 'approve', idempotencyKey: `chat-approve-${run.id}` });
    }
    if (run.status === 'ready') {
      run = (await this.startRun.execute({ ownerId: input.ownerId, runId: run.id, idempotencyKey: `chat-start-${run.id}` })).resource;
    }
    return { resource: run, replayed: created.replayed };
  }
}
