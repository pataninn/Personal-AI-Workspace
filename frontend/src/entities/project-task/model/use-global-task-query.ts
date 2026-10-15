import { useCallback, useEffect, useRef, useState } from 'react';

import { listGlobalTasks } from '@/entities/project-task/api/global-task-api';
import type { GlobalTaskQueryOptions } from '@/entities/project-task/api/global-task-api';
import type { GlobalTaskItem, GlobalTaskQueryPage } from '@/entities/project-task/model/types';
import { ApiClientError } from '@/shared/api';

export type GlobalTaskQueryStatus = 'idle' | 'loading' | 'success' | 'error';

interface QueryState {
  readonly key: string;
  readonly status: GlobalTaskQueryStatus;
  readonly items: readonly GlobalTaskItem[];
  readonly nextCursor: string | null;
  readonly error: unknown | null;
  readonly loadingMore: boolean;
  readonly loadMoreError: unknown | null;
  readonly refreshed: boolean;
}

const EMPTY_STATE: QueryState = {
  key: '', status: 'idle', items: [], nextCursor: null, error: null, loadingMore: false, loadMoreError: null, refreshed: false
};

export function useGlobalTaskQuery(query: GlobalTaskQueryOptions): {
  readonly items: readonly GlobalTaskItem[];
  readonly status: GlobalTaskQueryStatus;
  readonly error: unknown | null;
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly loadMoreError: unknown | null;
  readonly refreshed: boolean;
  readonly reload: () => Promise<GlobalTaskQueryPage | null>;
  readonly loadMore: () => Promise<void>;
} {
  const key = JSON.stringify(query);
  const [state, setState] = useState<QueryState>(EMPTY_STATE);
  const generation = useRef(0);
  const currentKey = useRef(key);
  currentKey.current = key;

  const reload = useCallback(async (): Promise<GlobalTaskQueryPage | null> => {
    const requestGeneration = ++generation.current;
    setState({ key, status: 'loading', items: [], nextCursor: null, error: null, loadingMore: false, loadMoreError: null, refreshed: false });
    try {
      const page = await listGlobalTasks(query);
      if (requestGeneration === generation.current && currentKey.current === key) {
        setState({ key, status: 'success', items: page.items, nextCursor: page.nextCursor, error: null, loadingMore: false, loadMoreError: null, refreshed: false });
      }
      return page;
    } catch (error: unknown) {
      if (requestGeneration === generation.current && currentKey.current === key) {
        setState({ key, status: 'error', items: [], nextCursor: null, error, loadingMore: false, loadMoreError: null, refreshed: false });
      }
      return null;
    }
  }, [key, query]);

  useEffect(() => {
    void reload();
    return () => { generation.current += 1; };
  }, [reload]);

  const loadMore = useCallback(async (): Promise<void> => {
    const current = state;
    if (current.key !== key || current.status !== 'success' || !current.nextCursor || current.loadingMore) return;
    const requestGeneration = generation.current;
    const cursor = current.nextCursor;
    setState((value) => value.key === key ? { ...value, loadingMore: true, loadMoreError: null, refreshed: false } : value);
    try {
      const page = await listGlobalTasks(query, cursor);
      if (requestGeneration === generation.current && currentKey.current === key) {
        setState((value) => value.key === key ? { ...value, items: [...value.items, ...page.items], nextCursor: page.nextCursor, loadingMore: false, loadMoreError: null } : value);
      }
    } catch (error: unknown) {
      if (requestGeneration !== generation.current || currentKey.current !== key) return;
      if (error instanceof ApiClientError && error.code === 'TASK_CURSOR_INVALID') {
        try {
          const firstPage = await listGlobalTasks(query);
          if (requestGeneration === generation.current && currentKey.current === key) {
            setState({ key, status: 'success', items: firstPage.items, nextCursor: firstPage.nextCursor, error: null, loadingMore: false, loadMoreError: null, refreshed: true });
          }
        } catch (refreshError: unknown) {
          if (requestGeneration === generation.current && currentKey.current === key) {
            setState((value) => value.key === key ? { ...value, loadingMore: false, loadMoreError: refreshError } : value);
          }
        }
      } else {
        setState((value) => value.key === key ? { ...value, loadingMore: false, loadMoreError: error } : value);
      }
    }
  }, [key, query, state]);

  if (state.key !== key) {
    return { items: [], status: 'loading', error: null, nextCursor: null, loadingMore: false, loadMoreError: null, refreshed: false, reload, loadMore };
  }
  return { items: state.items, status: state.status, error: state.error, nextCursor: state.nextCursor,
    loadingMore: state.loadingMore, loadMoreError: state.loadMoreError, refreshed: state.refreshed, reload, loadMore };
}
