import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import {
  ConversationNotFoundError,
  IdempotencyKeyRequiredError,
  ProjectArchivedError
} from '@/modules/conversations/domain/conversation-errors';
import { normalizeConversationTitle, validateMessageContent } from '@/modules/conversations/domain/conversation-validation';
import type { Conversation, ConversationPage, Message, MessagePage, PersistedResource } from '@/modules/conversations/domain/conversation-types';
import type {
  AddMessageRecord,
  CreateConversationRecord,
  FindConversationInput,
  IConversationRepository,
  ListConversationsInput
} from '@/modules/conversations/repositories/conversation-repository';

export interface ListConversationsInputDto extends ListConversationsInput {}

export class ListConversationsUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly conversationRepository: IConversationRepository
  ) {}

  public async execute(input: ListConversationsInputDto): Promise<ConversationPage> {
    await this.assertProject(input.ownerId, input.projectId);
    return this.conversationRepository.listByProjectForOwner(input);
  }

  private async assertProject(ownerId: string, projectId: string): Promise<void> {
    const project = await this.projectRepository.findByIdForOwner(ownerId, projectId);
    if (!project) {
      throw new ProjectNotFoundError();
    }
  }
}

export interface CreateConversationInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly title: unknown;
  readonly idempotencyKey: string;
}

export class CreateConversationUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly conversationRepository: IConversationRepository
  ) {}

  public async execute(input: CreateConversationInput): Promise<PersistedResource<Conversation>> {
    const project = await this.projectRepository.findByIdForOwner(input.ownerId, input.projectId);
    if (!project) {
      throw new ProjectNotFoundError();
    }
    if (project.status === 'archived') {
      throw new ProjectArchivedError();
    }
    assertIdempotencyKey(input.idempotencyKey);
    const title = normalizeConversationTitle(input.title);
    const record: CreateConversationRecord = {
      ownerId: input.ownerId,
      projectId: input.projectId,
      title,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: title
    };
    return this.conversationRepository.create(record);
  }
}

export interface GetConversationInput extends FindConversationInput {}

export class GetConversationUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly conversationRepository: IConversationRepository
  ) {}

  public async execute(input: GetConversationInput): Promise<MessagePage> {
    await this.assertProject(input.ownerId, input.projectId);
    const result = await this.conversationRepository.findWithMessagesForOwner(input);
    if (!result) {
      throw new ConversationNotFoundError();
    }
    return result;
  }

  private async assertProject(ownerId: string, projectId: string): Promise<void> {
    const project = await this.projectRepository.findByIdForOwner(ownerId, projectId);
    if (!project) {
      throw new ConversationNotFoundError();
    }
  }
}

export interface AddUserMessageInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly content: unknown;
  readonly idempotencyKey: string;
}

export class AddUserMessageUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly conversationRepository: IConversationRepository
  ) {}

  public async execute(input: AddUserMessageInput): Promise<PersistedResource<Message>> {
    const project = await this.projectRepository.findByIdForOwner(input.ownerId, input.projectId);
    if (!project) {
      throw new ConversationNotFoundError();
    }
    if (project.status === 'archived') {
      throw new ProjectArchivedError();
    }
    assertIdempotencyKey(input.idempotencyKey);
    const content = validateMessageContent(input.content);
    const record: AddMessageRecord = {
      ownerId: input.ownerId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      content,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: JSON.stringify({ conversationId: input.conversationId, content })
    };
    return this.conversationRepository.addUserMessage(record);
  }
}

function assertIdempotencyKey(value: string): void {
  if (!/^[\x21-\x7e]{8,200}$/u.test(value)) {
    throw new IdempotencyKeyRequiredError();
  }
}
