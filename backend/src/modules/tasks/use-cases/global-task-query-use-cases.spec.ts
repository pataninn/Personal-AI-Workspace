import { GlobalTaskNotFoundError, TaskQueryCursorInvalidError } from '@/modules/tasks/domain/global-task-query-errors';
import type { GlobalTaskQueryFilters } from '@/modules/tasks/domain/global-task-query';
import type { IGlobalTaskQueryRepository } from '@/modules/tasks/repositories/global-task-query-repository';
import { GetGlobalTaskUseCase, ListGlobalTasksUseCase } from '@/modules/tasks/use-cases/global-task-query-use-cases';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const FILTERS: GlobalTaskQueryFilters = { inboxOnly: false, includeArchived: false, limit: 10 };
const POSITION = { createdAt: '2026-10-16T08:09:10.123456Z', taskId: TASK };

function repository(overrides: Partial<jest.Mocked<IGlobalTaskQueryRepository>> = {}): jest.Mocked<IGlobalTaskQueryRepository> {
  return {
    listGlobalTasks: jest.fn().mockResolvedValue({ items: [], hasMore: false, lastPosition: null }),
    getGlobalTask: jest.fn().mockResolvedValue(null),
    ...overrides
  };
}

describe('global task query use cases', () => {
  it('queries using the authenticated owner and returns a cursor bound to the normalized filters', async () => {
    const taskQuery = repository({
      listGlobalTasks: jest.fn().mockResolvedValue({ items: [], hasMore: true, lastPosition: POSITION })
    });
    const useCase = new ListGlobalTasksUseCase(taskQuery);

    const page = await useCase.execute({ ownerId: OWNER, filters: { ...FILTERS, q: '  renewal  ' } });

    expect(taskQuery.listGlobalTasks).toHaveBeenCalledWith({
      ownerId: OWNER,
      filters: { ...FILTERS, q: 'renewal' },
      after: null
    });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeTruthy();
  });

  it('rejects a cursor from another owner or query before repository access', async () => {
    const taskQuery = repository({
      listGlobalTasks: jest.fn().mockResolvedValue({ items: [], hasMore: true, lastPosition: POSITION })
    });
    const useCase = new ListGlobalTasksUseCase(taskQuery);
    const cursor = (await useCase.execute({ ownerId: OWNER, filters: FILTERS })).nextCursor;
    if (!cursor) throw new Error('Expected the fixture to return a cursor.');

    await expect(useCase.execute({ ownerId: OTHER_OWNER, filters: FILTERS, cursor })).rejects.toBeInstanceOf(TaskQueryCursorInvalidError);
    await expect(useCase.execute({ ownerId: OWNER, filters: { ...FILTERS, inboxOnly: true }, cursor })).rejects.toBeInstanceOf(TaskQueryCursorInvalidError);
    expect(taskQuery.listGlobalTasks).toHaveBeenCalledTimes(1);
  });

  it('rejects incompatible Inbox/workspace filters and invalid date windows before querying', async () => {
    const taskQuery = repository();
    const useCase = new ListGlobalTasksUseCase(taskQuery);

    await expect(useCase.execute({ ownerId: OWNER, filters: { ...FILTERS, workspaceId: TASK, inboxOnly: true } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(useCase.execute({ ownerId: OWNER, filters: { ...FILTERS, deadlineFrom: '2026-10-17', deadlineTo: '2026-10-16' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(taskQuery.listGlobalTasks).not.toHaveBeenCalled();
  });

  it('returns one stable task detail or a non-disclosing not-found error', async () => {
    const taskQuery = repository();
    const useCase = new GetGlobalTaskUseCase(taskQuery);

    await expect(useCase.execute({ ownerId: OWNER, taskId: TASK, includeArchived: false })).rejects.toBeInstanceOf(GlobalTaskNotFoundError);
    expect(taskQuery.getGlobalTask).toHaveBeenCalledWith({ ownerId: OWNER, taskId: TASK, includeArchived: false });
  });
});
