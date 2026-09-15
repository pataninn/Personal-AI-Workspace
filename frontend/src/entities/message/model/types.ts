export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface MessageSnapshot {
  readonly id: string;
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly sequence: number;
  readonly content: string;
  readonly createdAt: string;
}
