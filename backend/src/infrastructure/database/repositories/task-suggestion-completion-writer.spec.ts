import type { DataSource, QueryRunner } from 'typeorm';

import {
  TypeOrmTaskSuggestionRepository,
  type TaskSuggestionRunContext
} from '@/infrastructure/database/repositories/task-suggestion-completion-writer';

const RUN_CONTEXT: TaskSuggestionRunContext = {
  runId: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  conversationId: '44444444-4444-4444-8444-444444444444'
};

function suggestionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    owner_id: RUN_CONTEXT.ownerId,
    project_id: RUN_CONTEXT.projectId,
    conversation_id: RUN_CONTEXT.conversationId,
    title: 'Review setup notes',
    details: 'Document the local startup steps.',
    status: 'pending',
    ...overrides
  };
}

describe('TypeOrmTaskSuggestionRepository', () => {
  describe('persistForRunCompletion', () => {
    it('should unwrap PostgreSQL QueryRunner rows and rowCount when inserting a suggestion', async () => {
      const inserted = suggestionRow();
      const query = jest.fn()
        .mockResolvedValueOnce([[inserted], 1])
        .mockResolvedValueOnce([[], 1]);
      const queryRunner = { query } as unknown as QueryRunner;
      const repository = new TypeOrmTaskSuggestionRepository({} as DataSource);

      await repository.persistForRunCompletion(queryRunner, RUN_CONTEXT, [
        { title: ' Review setup notes ', details: ' Document the local startup steps. ' }
      ]);

      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[0]?.[0]).toContain('INSERT INTO "project_task_suggestions"');
      expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT ("run_id", "ordinal") DO NOTHING');
      expect(query.mock.calls[0]?.[1]).toEqual([
        RUN_CONTEXT.ownerId,
        RUN_CONTEXT.projectId,
        RUN_CONTEXT.runId,
        RUN_CONTEXT.conversationId,
        0,
        'Review setup notes',
        'Document the local startup steps.',
        '[]'
      ]);
      expect(query.mock.calls[1]?.[0]).toContain("'task.suggestion_proposed'");
      expect(query.mock.calls[1]?.[0]).toContain('ON CONFLICT');
      expect(query.mock.calls[1]?.[1]).toEqual([
        RUN_CONTEXT.ownerId,
        RUN_CONTEXT.projectId,
        inserted.id,
        RUN_CONTEXT.runId,
        0
      ]);
    });

    it('should load the matching prior row after an idempotent insert conflict', async () => {
      const existing = suggestionRow({ id: '66666666-6666-4666-8666-666666666666' });
      const query = jest.fn()
        .mockResolvedValueOnce([[], 0])
        .mockResolvedValueOnce([[existing], 1])
        .mockResolvedValueOnce([[], 0]);
      const queryRunner = { query } as unknown as QueryRunner;
      const repository = new TypeOrmTaskSuggestionRepository({} as DataSource);

      await repository.persistForRunCompletion(queryRunner, RUN_CONTEXT, [
        { title: 'Review setup notes', details: 'Document the local startup steps.' }
      ]);

      expect(query).toHaveBeenCalledTimes(3);
      expect(query.mock.calls[1]?.[0]).toContain('FROM "project_task_suggestions" WHERE "run_id" = $1 AND "ordinal" = $2');
      expect(query.mock.calls[1]?.[1]).toEqual([RUN_CONTEXT.runId, 0]);
      expect(query.mock.calls[2]?.[1]?.[2]).toBe(existing.id);
    });

    it('should reject a prior suggestion that does not match the locked run context', async () => {
      const conflicting = suggestionRow({ project_id: '77777777-7777-4777-8777-777777777777' });
      const query = jest.fn()
        .mockResolvedValueOnce([[], 0])
        .mockResolvedValueOnce([[conflicting], 1]);
      const queryRunner = { query } as unknown as QueryRunner;
      const repository = new TypeOrmTaskSuggestionRepository({} as DataSource);

      await expect(repository.persistForRunCompletion(queryRunner, RUN_CONTEXT, [
        { title: 'Review setup notes', details: 'Document the local startup steps.' }
      ])).rejects.toThrow('The task suggestion completion write did not match its run context.');
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('should validate provider drafts before sending any query', async () => {
      const query = jest.fn();
      const queryRunner = { query } as unknown as QueryRunner;
      const repository = new TypeOrmTaskSuggestionRepository({} as DataSource);
      const tooManyDrafts = Array.from({ length: 6 }, (_, index) => ({ title: `Suggestion ${index + 1}` }));

      await expect(repository.persistForRunCompletion(queryRunner, RUN_CONTEXT, tooManyDrafts))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(query).not.toHaveBeenCalled();
    });
  });
});
