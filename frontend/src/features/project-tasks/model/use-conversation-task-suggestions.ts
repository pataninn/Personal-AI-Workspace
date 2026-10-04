import { useCallback, useEffect, useRef, useState } from 'react';

import { listConversationProjectTaskSuggestions, listProjectTasks } from '@/entities/project-task';
import type { ProjectTask, ProjectTaskSuggestion } from '@/entities/project-task';

export type ConversationTaskSuggestionStatus = 'idle' | 'loading' | 'success' | 'error';

interface ConversationSuggestionState {
  readonly projectId: string;
  readonly conversationId: string;
  readonly status: ConversationTaskSuggestionStatus;
  readonly suggestions: readonly ProjectTaskSuggestion[];
  readonly acceptedTasks: Readonly<Record<string, ProjectTask>>;
}

export function useConversationTaskSuggestions(projectId: string, conversationId: string): {
  readonly suggestions: readonly ProjectTaskSuggestion[];
  readonly acceptedTasks: Readonly<Record<string, ProjectTask>>;
  readonly status: ConversationTaskSuggestionStatus;
  readonly reload: () => Promise<void>;
  readonly resolveSuggestion: (suggestion: ProjectTaskSuggestion, task: ProjectTask | null) => void;
} {
  const [state, setState] = useState<ConversationSuggestionState>({ projectId: '', conversationId: '', status: 'idle', suggestions: [], acceptedTasks: {} });
  const generationRef = useRef(0);
  const currentScopeRef = useRef({ projectId, conversationId });
  currentScopeRef.current = { projectId, conversationId };

  const reload = useCallback(async (): Promise<void> => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!conversationId) {
      setState({ projectId, conversationId, status: 'success', suggestions: [], acceptedTasks: {} });
      return;
    }
    setState({ projectId, conversationId, status: 'loading', suggestions: [], acceptedTasks: {} });
    try {
      const suggestions = await listConversationProjectTaskSuggestions(projectId, conversationId);
      const acceptedTasks = await loadAcceptedTasks(projectId, suggestions);
      if (generation === generationRef.current && isCurrentScope(currentScopeRef.current, projectId, conversationId)) {
        setState({ projectId, conversationId, status: 'success', suggestions, acceptedTasks });
      }
    } catch {
      if (generation === generationRef.current && isCurrentScope(currentScopeRef.current, projectId, conversationId)) {
        setState({ projectId, conversationId, status: 'error', suggestions: [], acceptedTasks: {} });
      }
    }
  }, [conversationId, projectId]);

  useEffect(() => {
    void reload();
    return () => { generationRef.current += 1; };
  }, [reload]);

  useEffect(() => {
    function refreshForConversation(event: Event): void {
      if (readConversationId(event) === conversationId) {
        void reload();
      }
    }
    function refreshWhenVisible(): void {
      if (document.visibilityState === 'visible') {
        void reload();
      }
    }
    window.addEventListener('personal-ai:task-suggestions-refresh', refreshForConversation);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('personal-ai:task-suggestions-refresh', refreshForConversation);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [conversationId, reload]);

  const resolveSuggestion = useCallback((suggestion: ProjectTaskSuggestion, task: ProjectTask | null): void => {
    if (suggestion.projectId !== projectId || suggestion.conversationId !== conversationId) {
      return;
    }
    setState((current) => {
      if (!isCurrentScope(current, projectId, conversationId) || current.status !== 'success') {
        return current;
      }
      const suggestions = [...current.suggestions.filter((candidate) => candidate.id !== suggestion.id), suggestion]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      const acceptedTasks = { ...current.acceptedTasks };
      if (task) {
        acceptedTasks[suggestion.id] = task;
      }
      return { ...current, suggestions, acceptedTasks };
    });
  }, [conversationId, projectId]);

  const stateMatchesScope = isCurrentScope(state, projectId, conversationId);
  return {
    suggestions: stateMatchesScope ? state.suggestions : [],
    acceptedTasks: stateMatchesScope ? state.acceptedTasks : {},
    status: stateMatchesScope ? state.status : 'loading',
    reload,
    resolveSuggestion
  };
}

async function loadAcceptedTasks(projectId: string, suggestions: readonly ProjectTaskSuggestion[]): Promise<Readonly<Record<string, ProjectTask>>> {
  const accepted = suggestions.filter((suggestion) => suggestion.status === 'accepted' && suggestion.taskId !== null);
  if (accepted.length === 0) {
    return {};
  }
  try {
    const active = await listProjectTasks(projectId, 'all');
    const tasks = active.tasks;
    return Object.fromEntries(accepted.flatMap((suggestion) => {
      const task = tasks.find((candidate) => candidate.id === suggestion.taskId);
      return task ? [[suggestion.id, task]] : [];
    }));
  } catch {
    return {};
  }
}

function isCurrentScope(state: Pick<ConversationSuggestionState, 'projectId' | 'conversationId'>, projectId: string, conversationId: string): boolean {
  return state.projectId === projectId && state.conversationId === conversationId;
}

function readConversationId(event: Event): string | null {
  if (!(event instanceof CustomEvent) || typeof event.detail !== 'object' || event.detail === null) {
    return null;
  }
  const { conversationId } = event.detail as { readonly conversationId?: unknown };
  return typeof conversationId === 'string' ? conversationId : null;
}
