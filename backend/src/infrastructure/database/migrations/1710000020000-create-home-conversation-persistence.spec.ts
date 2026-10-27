import type { QueryRunner } from 'typeorm';

import { HomeConversationRollbackBlockedError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { CreateHomeConversationPersistence1710000020000 } from '@/infrastructure/database/migrations/1710000020000-create-home-conversation-persistence';

describe('CreateHomeConversationPersistence1710000020000', () => {
  it('creates separate owner-scoped history tables with ordering and request constraints', async () => {
    const queries: string[] = [];
    const queryRunner = { query: async (query: string) => { queries.push(query); return []; } } as unknown as QueryRunner;

    await new CreateHomeConversationPersistence1710000020000().up(queryRunner);

    expect(queries.join('\n')).toContain('CREATE TYPE "home_conversation_scope"');
    expect(queries.join('\n')).toContain('CREATE TABLE "home_conversations"');
    expect(queries.join('\n')).toContain('CREATE TABLE "home_turns"');
    expect(queries.join('\n')).toContain('CREATE TABLE "home_messages"');
    expect(queries.join('\n')).toContain('FOREIGN KEY ("owner_id", "conversation_id") REFERENCES "home_conversations"');
    expect(queries.join('\n')).toContain('UNIQUE ("owner_id", "conversation_id", "sequence")');
    expect(queries.join('\n')).toContain('UNIQUE ("owner_id", "conversation_id", "request_key")');
    expect(queries.join('\n')).toContain('WHERE "scope" = \'home\'');
    expect(queries.join('\n')).toContain('WHERE "scope" = \'workspace\'');
  });

  it('refuses rollback before any DDL if Home history exists', async () => {
    const query = jest.fn().mockResolvedValue([{ has_records: true }]);
    const queryRunner = { query } as unknown as QueryRunner;

    await expect(new CreateHomeConversationPersistence1710000020000().down(queryRunner)).rejects.toBeInstanceOf(HomeConversationRollbackBlockedError);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('FROM "home_conversations"');
    expect(query.mock.calls[0]?.[0]).toContain('FROM "home_turns"');
    expect(query.mock.calls[0]?.[0]).toContain('FROM "home_messages"');
  });

  it('reverts an empty schema only after checking for retained rows', async () => {
    const queries: string[] = [];
    const query = jest.fn(async (statement: string) => {
      queries.push(statement);
      return queries.length === 1 ? [{ has_records: false }] : [];
    });
    const queryRunner = { query } as unknown as QueryRunner;

    await new CreateHomeConversationPersistence1710000020000().down(queryRunner);

    expect(queries[0]).toContain('SELECT EXISTS');
    expect(queries[1]).toBe('DROP INDEX "IDX_home_conversations_owner_scope_activity"');
    expect(queries.at(-1)).toBe('DROP TYPE "home_conversation_scope"');
  });
});
