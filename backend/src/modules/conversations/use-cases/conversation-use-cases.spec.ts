import type { Project } from '@/modules/projects/domain/project-types';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import {
  AddUserMessageUseCase,
  CreateConversationUseCase,
  GetConversationUseCase
} from '@/modules/conversations/use-cases';
import type { Conversation, Message, MessagePage, PersistedResource } from '@/modules/conversations/domain/conversation-types';
import type {
  AddMessageRecord,
  CreateConversationRecord,
  FindConversationInput,
  IConversationRepository,
  ListConversationsInput
} from '@/modules/conversations/repositories/conversation-repository';
import { ProjectArchivedError, ConversationNotFoundError } from '@/modules/conversations/domain/conversation-errors';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-12T12:00:00.000Z');

const project: Project = {
  id: PROJECT_ID,
  ownerId: 'user-1',
  name: 'Workspace',
  slug: 'workspace',
  relativeRoot: 'workspace',
  status: 'active',
  version: 1,
  createdAt: NOW,
  updatedAt: NOW
};

class ProjectRepositoryFixture implements IProjectRepository {
  public current: Project | null = project;

  public async listByOwner(): Promise<readonly Project[]> { return this.current ? [this.current] : []; }
  public async findByIdForOwner(ownerId: string, projectId: string): Promise<Project | null> {
    return this.current?.ownerId === ownerId && this.current.id === projectId ? this.current : null;
  }
  public async listActiveRoots(): Promise<readonly string[]> { return []; }
  public async create(): Promise<Project> { return project; }
  public async updateStatus(): Promise<Project | null> { return this.current; }
}

class ConversationRepositoryFixture implements IConversationRepository {
  public createInput: CreateConversationRecord | null = null;
  public messageInput: AddMessageRecord | null = null;
  public conversation: Conversation = {
    id: CONVERSATION_ID,
    ownerId: 'user-1',
    projectId: PROJECT_ID,
    title: 'Notes',
    status: 'active',
    lastActivityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  };
  public message: Message = {
    id: '33333333-3333-4333-8333-333333333333',
    conversationId: CONVERSATION_ID,
    role: 'user',
    sequence: 1,
    content: 'Hello',
    createdAt: NOW
  };
  public found = true;

  public async listByProjectForOwner(_input: ListConversationsInput) {
    return { conversations: [this.conversation], nextCursor: null };
  }
  public async findWithMessagesForOwner(_input: FindConversationInput): Promise<MessagePage | null> {
    return this.found ? { conversation: this.conversation, messages: [this.message], nextBeforeSequence: null } : null;
  }
  public async create(input: CreateConversationRecord): Promise<PersistedResource<Conversation>> {
    this.createInput = input;
    return { resource: this.conversation, replayed: false };
  }
  public async addUserMessage(input: AddMessageRecord): Promise<PersistedResource<Message>> {
    this.messageInput = input;
    return { resource: this.message, replayed: false };
  }
}

describe('conversation use cases', () => {
  it('normalizes a create title and passes the owner/project idempotency intent', async () => {
    const projects = new ProjectRepositoryFixture();
    const conversations = new ConversationRepositoryFixture();
    const result = await new CreateConversationUseCase(projects, conversations).execute({
      ownerId: 'user-1', projectId: PROJECT_ID, title: '  Notes  ', idempotencyKey: 'create-key-1'
    });

    expect(result.replayed).toBe(false);
    expect(conversations.createInput).toMatchObject({ ownerId: 'user-1', projectId: PROJECT_ID, title: 'Notes', requestFingerprint: 'Notes' });
  });

  it('rejects archived project mutations before persistence', async () => {
    const projects = new ProjectRepositoryFixture();
    projects.current = { ...project, status: 'archived' };
    const conversations = new ConversationRepositoryFixture();

    await expect(new CreateConversationUseCase(projects, conversations).execute({
      ownerId: 'user-1', projectId: PROJECT_ID, title: 'Notes', idempotencyKey: 'create-key-2'
    })).rejects.toBeInstanceOf(ProjectArchivedError);
    expect(conversations.createInput).toBeNull();
  });

  it('rejects whitespace-only messages and preserves valid multiline content', async () => {
    const projects = new ProjectRepositoryFixture();
    const conversations = new ConversationRepositoryFixture();
    const useCase = new AddUserMessageUseCase(projects, conversations);

    await expect(useCase.execute({ ownerId: 'user-1', projectId: PROJECT_ID, conversationId: CONVERSATION_ID, content: '  \n', idempotencyKey: 'message-key-1' })).rejects.toThrow('message content is invalid');
    await useCase.execute({ ownerId: 'user-1', projectId: PROJECT_ID, conversationId: CONVERSATION_ID, content: ' first\nsecond ', idempotencyKey: 'message-key-2' });
    expect(conversations.messageInput).toMatchObject({
      content: ' first\nsecond ',
      requestFingerprint: JSON.stringify({ conversationId: CONVERSATION_ID, content: ' first\nsecond ' })
    });
  });

  it('hides a conversation that the repository cannot resolve in the supplied project', async () => {
    const projects = new ProjectRepositoryFixture();
    const conversations = new ConversationRepositoryFixture();
    conversations.found = false;

    await expect(new GetConversationUseCase(projects, conversations).execute({
      ownerId: 'user-1', projectId: PROJECT_ID, conversationId: CONVERSATION_ID, limit: 20
    })).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});
