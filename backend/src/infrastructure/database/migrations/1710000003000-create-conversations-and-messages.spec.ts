import type { QueryRunner } from 'typeorm';

import { CreateConversationsAndMessages1710000003000 } from '@/infrastructure/database/migrations/1710000003000-create-conversations-and-messages';

describe('CreateConversationsAndMessages1710000003000', () => {
  it('creates and reverses the conversation/message/idempotency schema', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const queryRunner = { query } as unknown as QueryRunner;
    const migration = new CreateConversationsAndMessages1710000003000();

    await migration.up(queryRunner);
    await migration.down(queryRunner);

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('CREATE TYPE "conversation_status"'));
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('CREATE TYPE "message_role"'));
    expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining('CREATE TABLE "conversations"'));
    expect(query).toHaveBeenNthCalledWith(4, expect.stringContaining('CREATE TABLE "messages"'));
    expect(query).toHaveBeenNthCalledWith(5, expect.stringContaining('CREATE TABLE "conversation_idempotency_keys"'));
    expect(query).toHaveBeenNthCalledWith(6, expect.stringContaining('IDX_conversations_owner_project_activity'));
    expect(query).toHaveBeenNthCalledWith(7, expect.stringContaining('IDX_messages_conversation_sequence'));
    expect(query).toHaveBeenNthCalledWith(8, expect.stringContaining('UQ_conversation_idempotency_scope'));
    expect(query).toHaveBeenNthCalledWith(9, expect.stringContaining('IDX_conversation_idempotency_resource'));
    expect(query).toHaveBeenNthCalledWith(10, 'DROP INDEX "IDX_conversation_idempotency_resource"');
    expect(query).toHaveBeenNthCalledWith(11, 'DROP INDEX "UQ_conversation_idempotency_scope"');
    expect(query).toHaveBeenNthCalledWith(12, 'DROP INDEX "IDX_messages_conversation_sequence"');
    expect(query).toHaveBeenNthCalledWith(13, 'DROP INDEX "IDX_conversations_owner_project_activity"');
    expect(query).toHaveBeenNthCalledWith(14, 'DROP TABLE "conversation_idempotency_keys"');
    expect(query).toHaveBeenNthCalledWith(15, 'DROP TABLE "messages"');
    expect(query).toHaveBeenNthCalledWith(16, 'DROP TABLE "conversations"');
    expect(query).toHaveBeenNthCalledWith(17, 'DROP TYPE "message_role"');
    expect(query).toHaveBeenNthCalledWith(18, 'DROP TYPE "conversation_status"');
  });
});
