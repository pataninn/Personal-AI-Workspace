import { useCallback, useEffect, useRef, useState } from 'react';

import { listProjectTasks } from '@/entities/project-task/api/project-task-api';
import type { ProjectTask, ProjectTaskFilter, ProjectTaskList } from '@/entities/project-task/model/types';
import { compareTaskPriority } from '@/entities/project-task/model/task-priority';

export type ProjectTaskLoadStatus = 'idle' | 'loading' | 'success' | 'error';

interface ProjectTaskState {
  readonly projectId: string;
  readonly filter: ProjectTaskFilter;
  readonly status: ProjectTaskLoadStatus;
  readonly tasks: readonly ProjectTask[];
  readonly orderVersion: number | null;
  readonly error: unknown | null;
}

export function useProjectTasks(projectId: string, filter: ProjectTaskFilter): {
  readonly tasks: readonly ProjectTask[];
  readonly orderVersion: number | null;
  readonly status: ProjectTaskLoadStatus;
  readonly error: unknown | null;
  readonly reload: () => Promise<ProjectTaskList | null>;
  readonly replaceTasks: (list: ProjectTaskList) => void;
  readonly upsertTask: (task: ProjectTask, orderVersion?: number) => void;
} {
  const [state, setState] = useState<ProjectTaskState>({ projectId: '', filter, status: 'idle', tasks: [], orderVersion: null, error: null });
  const generationRef = useRef(0);
  const currentProjectIdRef = useRef(projectId);
  const currentFilterRef = useRef(filter);
  currentProjectIdRef.current = projectId;
  currentFilterRef.current = filter;

  const reload = useCallback(async (): Promise<ProjectTaskList | null> => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setState((current) => isCurrentScope(current.projectId, current.filter, projectId, filter)
      ? { ...current, status: 'loading', error: null }
      : { projectId, filter, status: 'loading', tasks: [], orderVersion: null, error: null });
    try {
      const list = await listProjectTasks(projectId, filter);
      if (generation === generationRef.current && isCurrentScope(currentProjectIdRef.current, currentFilterRef.current, projectId, filter)) {
        setState({ projectId, filter, status: 'success', tasks: list.tasks, orderVersion: list.orderVersion, error: null });
      }
      return list;
    } catch (error: unknown) {
      if (generation === generationRef.current && isCurrentScope(currentProjectIdRef.current, currentFilterRef.current, projectId, filter)) {
        setState({ projectId, filter, status: 'error', tasks: [], orderVersion: null, error });
      }
      return null;
    }
  }, [filter, projectId]);

  useEffect(() => {
    void reload();
    return () => { generationRef.current += 1; };
  }, [reload]);

  useEffect(() => {
    const refreshTasks = (event: Event): void => {
      if (event instanceof CustomEvent && event.detail?.projectId === projectId) void reload();
    };
    window.addEventListener('personal-ai:project-tasks-refresh', refreshTasks);
    return () => { window.removeEventListener('personal-ai:project-tasks-refresh', refreshTasks); };
  }, [projectId, reload]);

  const replaceTasks = useCallback((list: ProjectTaskList): void => {
    if (list.tasks.some((task) => task.projectId !== projectId)) {
      return;
    }
    setState((current) => isCurrentScope(current.projectId, current.filter, projectId, filter) && current.status === 'success'
      ? { ...current, tasks: list.tasks, orderVersion: list.orderVersion }
      : current);
  }, [filter, projectId]);

  const upsertTask = useCallback((task: ProjectTask, orderVersion?: number): void => {
    if (task.projectId !== projectId) {
      return;
    }
    setState((current) => {
      if (!isCurrentScope(current.projectId, current.filter, projectId, filter) || current.status !== 'success') {
        return current;
      }
      const tasks = [...current.tasks.filter((candidate) => candidate.id !== task.id), task].sort(compareTaskPriority);
      return { ...current, tasks, orderVersion: orderVersion ?? current.orderVersion };
    });
  }, [filter, projectId]);

  const stateMatchesScope = isCurrentScope(state.projectId, state.filter, projectId, filter);
  return {
    tasks: stateMatchesScope ? state.tasks : [],
    orderVersion: stateMatchesScope ? state.orderVersion : null,
    status: stateMatchesScope ? state.status : 'loading',
    error: stateMatchesScope ? state.error : null,
    reload,
    replaceTasks,
    upsertTask
  };
}

function isCurrentScope(currentProjectId: string, currentFilter: ProjectTaskFilter, projectId: string, filter: ProjectTaskFilter): boolean {
  return currentProjectId === projectId && currentFilter === filter;
}
