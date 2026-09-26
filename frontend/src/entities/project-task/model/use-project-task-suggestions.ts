import { useCallback, useEffect, useRef, useState } from 'react';

import { listProjectTaskSuggestions } from '@/entities/project-task/api/project-task-api';
import type { ProjectTaskSuggestion } from '@/entities/project-task/model/types';

export type ProjectTaskSuggestionLoadStatus = 'idle' | 'loading' | 'success' | 'error';

interface SuggestionState {
  readonly projectId: string;
  readonly status: ProjectTaskSuggestionLoadStatus;
  readonly suggestions: readonly ProjectTaskSuggestion[];
}

export function useProjectTaskSuggestions(projectId: string): {
  readonly suggestions: readonly ProjectTaskSuggestion[];
  readonly status: ProjectTaskSuggestionLoadStatus;
  readonly reload: () => Promise<readonly ProjectTaskSuggestion[] | null>;
  readonly removeSuggestion: (suggestionId: string) => void;
} {
  const [state, setState] = useState<SuggestionState>({ projectId: '', status: 'idle', suggestions: [] });
  const generationRef = useRef(0);
  const currentProjectIdRef = useRef(projectId);
  currentProjectIdRef.current = projectId;

  const reload = useCallback(async (): Promise<readonly ProjectTaskSuggestion[] | null> => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setState({ projectId, status: 'loading', suggestions: [] });
    try {
      const suggestions = await listProjectTaskSuggestions(projectId);
      if (generation === generationRef.current && currentProjectIdRef.current === projectId) {
        setState({ projectId, status: 'success', suggestions });
      }
      return suggestions;
    } catch {
      if (generation === generationRef.current && currentProjectIdRef.current === projectId) {
        setState({ projectId, status: 'error', suggestions: [] });
      }
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
    return () => { generationRef.current += 1; };
  }, [reload]);

  const removeSuggestion = useCallback((suggestionId: string): void => {
    setState((current) => current.projectId === projectId && current.status === 'success'
      ? { ...current, suggestions: current.suggestions.filter((suggestion) => suggestion.id !== suggestionId) }
      : current);
  }, [projectId]);

  return {
    suggestions: state.projectId === projectId ? state.suggestions : [],
    status: state.projectId === projectId ? state.status : 'loading',
    reload,
    removeSuggestion
  };
}
