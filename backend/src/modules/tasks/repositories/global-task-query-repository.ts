import type {
  GlobalTaskQueryCursorPosition,
  GlobalTaskQueryFilters,
  GlobalTaskQueryItem
} from '@/modules/tasks/domain/global-task-query';

export interface GlobalTaskQueryRepositoryPage {
  readonly items: readonly GlobalTaskQueryItem[];
  readonly hasMore: boolean;
  readonly lastPosition: GlobalTaskQueryCursorPosition | null;
}

export interface IGlobalTaskQueryRepository {
  listGlobalTasks(input: {
    readonly ownerId: string;
    readonly filters: GlobalTaskQueryFilters;
    readonly after: GlobalTaskQueryCursorPosition | null;
  }): Promise<GlobalTaskQueryRepositoryPage>;
  getGlobalTask(input: {
    readonly ownerId: string;
    readonly taskId: string;
    readonly includeArchived: boolean;
  }): Promise<GlobalTaskQueryItem | null>;
}
