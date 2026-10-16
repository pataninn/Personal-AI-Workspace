import type { IProjectChatContextRepository } from '@/modules/ai-runs/repositories/project-chat-context-repository';
import type { IProjectFactRepository } from '@/modules/memory/repositories/project-fact-repository';
import { AiRunProviderPermissionRevokedError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { CreateAiRunUseCase, DecideEgressUseCase, CreateAiRunOutput } from '@/modules/ai-runs/use-cases/ai-run-use-cases';

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
    private readonly decideEgress: Pick<DecideEgressUseCase, 'approveWithRememberedPermission'>
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
      try {
        run = await this.decideEgress.approveWithRememberedPermission({ ownerId: input.ownerId, runId: run.id }) ?? run;
      } catch (error: unknown) {
        // A grant revoked between exact-scope lookup and decision stays pending for explicit review.
        if (!(error instanceof AiRunProviderPermissionRevokedError)) throw error;
      }
    }
    return { resource: run, replayed: created.replayed };
  }
}
