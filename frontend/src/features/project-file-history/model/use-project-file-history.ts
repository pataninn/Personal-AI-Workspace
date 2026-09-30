import { useCallback, useEffect, useRef, useState } from 'react';

import { listProjectFileHistory, type ProjectFileHistoryItem, type ProjectFileHistoryOutcome } from '@/entities/ai-run';

type LoadStatus = 'loading' | 'success' | 'error';
interface HistoryState {
  readonly scope: string;
  readonly status: LoadStatus;
  readonly items: readonly ProjectFileHistoryItem[];
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly announcement: string;
  readonly error: unknown | null;
  readonly moreError: unknown | null;
}

function emptyState(scope: string, status: LoadStatus): HistoryState {
  return { scope, status, items: [], nextCursor: null, loadingMore: false, announcement: '', error: null, moreError: null };
}

export function useProjectFileHistory(projectId: string, path: string, outcome: ProjectFileHistoryOutcome): {
  readonly status: LoadStatus;
  readonly items: readonly ProjectFileHistoryItem[];
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly announcement: string;
  readonly error: unknown | null;
  readonly moreError: unknown | null;
  readonly reload: () => Promise<void>;
  readonly loadMore: () => Promise<void>;
} {
  const scope = `${projectId}:${path}:${outcome}`;
  const [state, setState] = useState<HistoryState>(() => emptyState('', 'loading'));
  const generationRef = useRef(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const reload = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    setState(emptyState(scope, 'loading'));
    try {
      const page = await listProjectFileHistory(projectId, path, outcome);
      if (generation === generationRef.current && scopeRef.current === scope && page.projectId === projectId && page.path === path && page.outcome === outcome) {
        setState({ ...emptyState(scope, 'success'), items: page.items, nextCursor: page.nextCursor });
      }
    } catch (error: unknown) {
      if (generation === generationRef.current && scopeRef.current === scope) setState({ ...emptyState(scope, 'error'), error });
    }
  }, [outcome, path, projectId, scope]);

  useEffect(() => {
    if (projectId && path) void reload();
    return () => { generationRef.current += 1; };
  }, [path, projectId, reload]);

  const loadMore = useCallback(async (): Promise<void> => {
    const current = state.scope === scope ? state : null;
    if (!current?.nextCursor || current.loadingMore || current.status !== 'success') return;
    const cursor = current.nextCursor;
    const generation = generationRef.current;
    setState((previous) => previous.scope === scope ? { ...previous, loadingMore: true, announcement: 'Loading more file history.', moreError: null } : previous);
    try {
      const page = await listProjectFileHistory(projectId, path, outcome, cursor);
      if (generation === generationRef.current && scopeRef.current === scope && page.projectId === projectId && page.path === path && page.outcome === outcome) {
        setState((previous) => previous.scope === scope ? { ...previous, items: [...previous.items, ...page.items], nextCursor: page.nextCursor, loadingMore: false, announcement: 'More file history loaded.', moreError: null } : previous);
      }
    } catch (error: unknown) {
      if (generation === generationRef.current && scopeRef.current === scope) setState((previous) => previous.scope === scope ? { ...previous, loadingMore: false, announcement: 'More file history could not be loaded.', moreError: error } : previous);
    }
  }, [outcome, path, projectId, scope, state]);

  const matches = state.scope === scope;
  return {
    status: matches ? state.status : 'loading',
    items: matches ? state.items : [],
    nextCursor: matches ? state.nextCursor : null,
    loadingMore: matches && state.loadingMore,
    announcement: matches ? state.announcement : '',
    error: matches ? state.error : null,
    moreError: matches ? state.moreError : null,
    reload,
    loadMore
  };
}
