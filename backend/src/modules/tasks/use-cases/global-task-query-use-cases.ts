import { GlobalTaskNotFoundError } from '@/modules/tasks/domain/global-task-query-errors';
import {
  decodeGlobalTaskQueryCursor,
  encodeGlobalTaskQueryCursor
} from '@/modules/tasks/domain/global-task-query-cursor';
import type {
  GlobalTaskQueryFilters,
  GlobalTaskQueryPage
} from '@/modules/tasks/domain/global-task-query';
import { ProjectTaskValidationError } from '@/modules/tasks/domain/project-task-errors';
import type { IGlobalTaskQueryRepository } from '@/modules/tasks/repositories/global-task-query-repository';

function normalizedFilters(filters: GlobalTaskQueryFilters): GlobalTaskQueryFilters {
  const q = filters.q?.trim();
  if (filters.inboxOnly && filters.workspaceId) {
    throw new ProjectTaskValidationError([{ field: 'workspaceId', message: 'Choose either Inbox or one workspace.' }]);
  }
  if (!Number.isSafeInteger(filters.limit) || filters.limit < 1 || filters.limit > 100) {
    throw new ProjectTaskValidationError([{ field: 'limit', message: 'Use a page size from 1 through 100.' }]);
  }
  if (filters.deadlineFrom && filters.deadlineTo && filters.deadlineFrom > filters.deadlineTo) {
    throw new ProjectTaskValidationError([{ field: 'deadlineFrom', message: 'The start date must not be later than the end date.' }]);
  }
  return {
    ...(filters.workspaceId ? { workspaceId: filters.workspaceId } : {}),
    inboxOnly: filters.inboxOnly,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.importance ? { importance: filters.importance } : {}),
    ...(filters.deadlineFrom ? { deadlineFrom: filters.deadlineFrom } : {}),
    ...(filters.deadlineTo ? { deadlineTo: filters.deadlineTo } : {}),
    ...(q ? { q } : {}),
    includeArchived: filters.includeArchived,
    limit: filters.limit
  };
}

export class ListGlobalTasksUseCase {
  public constructor(private readonly taskQueryRepository: IGlobalTaskQueryRepository) {}

  public async execute(input: {
    readonly ownerId: string;
    readonly filters: GlobalTaskQueryFilters;
    readonly cursor?: string;
  }): Promise<GlobalTaskQueryPage> {
    const filters = normalizedFilters(input.filters);
    const after = input.cursor
      ? decodeGlobalTaskQueryCursor(input.cursor, input.ownerId, filters)
      : null;
    const page = await this.taskQueryRepository.listGlobalTasks({ ownerId: input.ownerId, filters, after });
    const nextCursor = page.hasMore && page.lastPosition
      ? encodeGlobalTaskQueryCursor(page.lastPosition, input.ownerId, filters)
      : null;
    return { items: page.items, nextCursor };
  }
}

export class GetGlobalTaskUseCase {
  public constructor(private readonly taskQueryRepository: IGlobalTaskQueryRepository) {}

  public async execute(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly includeArchived: boolean;
  }) {
    const item = await this.taskQueryRepository.getGlobalTask(input);
    if (!item) throw new GlobalTaskNotFoundError();
    return item;
  }
}

export class CountInboxTasksUseCase {
  public constructor(private readonly taskQueryRepository: IGlobalTaskQueryRepository) {}

  public execute(input: { readonly ownerId: string }): Promise<number> {
    return this.taskQueryRepository.countInboxTasks(input);
  }
}
