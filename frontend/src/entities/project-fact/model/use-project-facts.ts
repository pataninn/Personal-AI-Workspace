import { useCallback, useEffect, useRef, useState } from 'react';

import { listProjectFacts } from '@/entities/project-fact/api/project-fact-api';
import type { ProjectFact } from '@/entities/project-fact/model/types';

export type ProjectFactListStatus = 'idle' | 'loading' | 'success' | 'error';

interface ProjectFactListState {
  readonly projectId: string;
  readonly status: ProjectFactListStatus;
  readonly facts: readonly ProjectFact[];
  readonly error: unknown | null;
}

export function useProjectFacts(projectId: string): {
  readonly facts: readonly ProjectFact[];
  readonly status: ProjectFactListStatus;
  readonly error: unknown | null;
  readonly reload: () => Promise<readonly ProjectFact[] | null>;
  readonly upsertFact: (fact: ProjectFact) => void;
  readonly removeFact: (factId: string) => void;
} {
  const [state, setState] = useState<ProjectFactListState>({ projectId: '', status: 'idle', facts: [], error: null });
  const generationRef = useRef(0);
  const currentProjectIdRef = useRef(projectId);
  currentProjectIdRef.current = projectId;

  const reload = useCallback(async (): Promise<readonly ProjectFact[] | null> => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setState({ projectId, status: 'loading', facts: [], error: null });
    try {
      const facts = await listProjectFacts(projectId);
      if (generation === generationRef.current && currentProjectIdRef.current === projectId) {
        setState({ projectId, status: 'success', facts, error: null });
      }
      return facts;
    } catch (error: unknown) {
      if (generation === generationRef.current && currentProjectIdRef.current === projectId) {
        setState({ projectId, status: 'error', facts: [], error });
      }
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
    return () => { generationRef.current += 1; };
  }, [reload]);

  const upsertFact = useCallback((fact: ProjectFact): void => {
    if (fact.projectId !== projectId) {
      return;
    }
    setState((current) => {
      if (current.projectId !== projectId || current.status !== 'success') {
        return current;
      }
      const facts = [...current.facts.filter((candidate) => candidate.id !== fact.id), fact]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
      return { ...current, facts };
    });
  }, [projectId]);

  const removeFact = useCallback((factId: string): void => {
    setState((current) => current.projectId === projectId && current.status === 'success'
      ? { ...current, facts: current.facts.filter((fact) => fact.id !== factId) }
      : current);
  }, [projectId]);

  const stateMatchesProject = state.projectId === projectId;
  return {
    facts: stateMatchesProject ? state.facts : [],
    status: stateMatchesProject ? state.status : 'loading',
    error: stateMatchesProject ? state.error : null,
    reload,
    upsertFact,
    removeFact
  };
}
