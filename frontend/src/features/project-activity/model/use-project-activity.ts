import { useCallback, useEffect, useRef, useState } from 'react';

import { getAiRunActivity, listAiRunActivity } from '@/entities/ai-run/api/activity-api';
import type { AiRunActivityDetail, AiRunActivityFilter, AiRunActivityItem } from '@/entities/ai-run/model/activity-types';

export type ProjectActivityLoadStatus = 'idle' | 'loading' | 'success' | 'error';

interface DetailState {
  readonly status: ProjectActivityLoadStatus;
  readonly detail: AiRunActivityDetail | null;
  readonly error: unknown | null;
}

interface ProjectActivityState {
  readonly scope: string;
  readonly status: ProjectActivityLoadStatus;
  readonly items: readonly AiRunActivityItem[];
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly loadMoreAnnouncement: string;
  readonly loadMoreError: unknown | null;
  readonly error: unknown | null;
  readonly details: Readonly<Record<string, DetailState>>;
}

const emptyState = (scope: string, status: ProjectActivityLoadStatus = 'idle'): ProjectActivityState => ({
  scope, status, items: [], nextCursor: null, loadingMore: false, loadMoreAnnouncement: '', loadMoreError: null, error: null, details: {}
});

export function useProjectActivity(projectId: string, filter: AiRunActivityFilter): {
  readonly items: readonly AiRunActivityItem[];
  readonly nextCursor: string | null;
  readonly status: ProjectActivityLoadStatus;
  readonly loadingMore: boolean;
  readonly loadMoreAnnouncement: string;
  readonly loadMoreError: unknown | null;
  readonly error: unknown | null;
  readonly details: Readonly<Record<string, DetailState>>;
  readonly reload: () => Promise<void>;
  readonly loadMore: () => Promise<void>;
  readonly loadDetail: (runId: string) => Promise<void>;
} {
  const scope = `${projectId}:${filter}`;
  const [state, setState] = useState<ProjectActivityState>(() => emptyState('', 'idle'));
  const generationRef = useRef(0);
  const currentScopeRef = useRef(scope);
  currentScopeRef.current = scope;

  const reload = useCallback(async (): Promise<void> => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setState(emptyState(scope, 'loading'));
    try {
      const page = await listAiRunActivity(projectId, filter);
      if (generation === generationRef.current && currentScopeRef.current === scope && page.projectId === projectId) {
        setState({ ...emptyState(scope, 'success'), items: page.items, nextCursor: page.nextCursor });
      }
    } catch (error: unknown) {
      if (generation === generationRef.current && currentScopeRef.current === scope) {
        setState({ ...emptyState(scope, 'error'), error });
      }
    }
  }, [filter, projectId, scope]);

  useEffect(() => {
    void reload();
    return () => { generationRef.current += 1; };
  }, [reload]);

  const loadMore = useCallback(async (): Promise<void> => {
    const current = state.scope === scope ? state : null;
    if (!current?.nextCursor || current.loadingMore || current.status !== 'success') return;
    const cursor = current.nextCursor;
    const generation = generationRef.current;
    setState((previous) => previous.scope === scope ? { ...previous, loadingMore: true, loadMoreAnnouncement: 'Loading the next page of activity.', loadMoreError: null } : previous);
    try {
      const page = await listAiRunActivity(projectId, filter, cursor);
      if (generation === generationRef.current && currentScopeRef.current === scope && page.projectId === projectId) {
        setState((previous) => previous.scope === scope
          ? { ...previous, status: 'success', items: mergeByRunId(previous.items, page.items), nextCursor: page.nextCursor, loadingMore: false, loadMoreAnnouncement: 'More activity loaded.', loadMoreError: null }
          : previous);
      }
    } catch (error: unknown) {
      if (generation === generationRef.current && currentScopeRef.current === scope) {
        setState((previous) => previous.scope === scope ? { ...previous, loadingMore: false, loadMoreAnnouncement: 'The next page could not be loaded.', loadMoreError: error } : previous);
      }
    }
  }, [filter, projectId, scope, state]);

  const loadDetail = useCallback(async (runId: string): Promise<void> => {
    const cached = state.scope === scope ? state.details[runId] : undefined;
    if (cached?.status === 'success' || cached?.status === 'loading') return;
    const generation = generationRef.current;
    setState((previous) => previous.scope === scope
      ? { ...previous, details: { ...previous.details, [runId]: { status: 'loading', detail: null, error: null } } }
      : previous);
    try {
      const detail = await getAiRunActivity(runId);
      if (generation === generationRef.current && currentScopeRef.current === scope && detail.projectId === projectId) {
        setState((previous) => previous.scope === scope
          ? { ...previous, details: { ...previous.details, [runId]: { status: 'success', detail, error: null } } }
          : previous);
      }
    } catch (error: unknown) {
      if (generation === generationRef.current && currentScopeRef.current === scope) {
        setState((previous) => previous.scope === scope
          ? { ...previous, details: { ...previous.details, [runId]: { status: 'error', detail: null, error } } }
          : previous);
      }
    }
  }, [projectId, scope, state]);

  const matchesScope = state.scope === scope;
  return {
    items: matchesScope ? state.items : [],
    nextCursor: matchesScope ? state.nextCursor : null,
    status: matchesScope ? state.status : 'loading',
    loadingMore: matchesScope && state.loadingMore,
    loadMoreAnnouncement: matchesScope ? state.loadMoreAnnouncement : '',
    loadMoreError: matchesScope ? state.loadMoreError : null,
    error: matchesScope ? state.error : null,
    details: matchesScope ? state.details : {},
    reload,
    loadMore,
    loadDetail
  };
}

function mergeByRunId(current: readonly AiRunActivityItem[], incoming: readonly AiRunActivityItem[]): readonly AiRunActivityItem[] {
  const ids = new Set(current.map((item) => item.runId));
  return [...current, ...incoming.filter((item) => !ids.has(item.runId))];
}
