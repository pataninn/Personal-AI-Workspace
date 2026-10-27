import { useCallback, useRef, useState } from 'react';

import {
  createProjectTask,
  deleteGlobalTask,
  decideProjectTaskSuggestion,
  reorderProjectTask,
  updateProjectTask
} from '@/entities/project-task';
import type {
  ProjectTask,
  ProjectTaskDraft,
  ProjectTaskStatus,
  ProjectTaskSuggestion,
  ProjectTaskSuggestionDecision,
  ProjectTaskUpdateResult,
  GlobalTaskDeleteResult
} from '@/entities/project-task';
import { ApiClientError } from '@/shared/api';

export function useProjectTaskActions(projectId: string, csrfToken: string | null): {
  readonly pendingKeys: readonly string[];
  readonly create: (draft: ProjectTaskDraft, idempotencyKey: string) => Promise<ProjectTaskUpdateResult>;
  readonly update: (task: ProjectTask, draft: ProjectTaskDraft, version: number) => Promise<ProjectTaskUpdateResult>;
  readonly transition: (task: ProjectTask, status: ProjectTaskStatus) => Promise<ProjectTaskUpdateResult>;
  readonly remove: (task: ProjectTask) => Promise<GlobalTaskDeleteResult>;
  readonly reorder: (taskId: string, direction: 'up' | 'down', orderVersion: number) => Promise<import('@/entities/project-task').ProjectTaskList>;
  readonly decideSuggestion: (suggestion: ProjectTaskSuggestion, decision: 'accepted' | 'dismissed', draft?: ProjectTaskDraft) => Promise<ProjectTaskSuggestionDecision>;
} {
  const [pendingKeys, setPendingKeys] = useState<readonly string[]>([]);
  const pendingRef = useRef(new Set<string>());
  const deleteIntents = useRef(new Map<string, string>());

  const run = useCallback(async <T,>(key: string, operation: (token: string) => Promise<T>): Promise<T> => {
    if (!csrfToken) {
      throw new ApiClientError(401, 'SESSION_UNAUTHENTICATED', 'The local session is not available.');
    }
    if (pendingRef.current.has(key)) {
      throw new ApiClientError(409, 'REQUEST_IN_PROGRESS', 'A task update is already in progress.');
    }
    pendingRef.current.add(key);
    setPendingKeys([...pendingRef.current]);
    try {
      return await operation(csrfToken);
    } finally {
      pendingRef.current.delete(key);
      setPendingKeys([...pendingRef.current]);
    }
  }, [csrfToken]);

  const create = useCallback((draft: ProjectTaskDraft, idempotencyKey: string): Promise<ProjectTaskUpdateResult> =>
    run('create', (token) => createProjectTask(projectId, draft, token, idempotencyKey)), [projectId, run]);
  const update = useCallback((task: ProjectTask, draft: ProjectTaskDraft, version: number): Promise<ProjectTaskUpdateResult> =>
    run(`task:${task.id}`, (token) => updateProjectTask(projectId, task.id, draft, version, token)), [projectId, run]);
  const transition = useCallback((task: ProjectTask, status: ProjectTaskStatus): Promise<ProjectTaskUpdateResult> =>
    run(`task:${task.id}`, (token) => updateProjectTask(projectId, task.id, { status }, task.version, token)), [projectId, run]);
  const remove = useCallback((task: ProjectTask): Promise<GlobalTaskDeleteResult> => run(`task:${task.id}`, async (token) => {
    const identity = `${task.id}:${task.version}`;
    const idempotencyKey = deleteIntents.current.get(identity) ?? crypto.randomUUID();
    deleteIntents.current.set(identity, idempotencyKey);
    const result = await deleteGlobalTask(task.id, task.version, token, idempotencyKey);
    deleteIntents.current.delete(identity);
    return result;
  }), [run]);
  const reorder = useCallback((taskId: string, direction: 'up' | 'down', orderVersion: number) =>
    run(`task:${taskId}`, (token) => reorderProjectTask(projectId, taskId, direction, orderVersion, token)), [projectId, run]);
  const decideSuggestion = useCallback((suggestion: ProjectTaskSuggestion, decision: 'accepted' | 'dismissed', draft?: ProjectTaskDraft) =>
    run(`suggestion:${suggestion.id}`, (token) => decideProjectTaskSuggestion(projectId, suggestion, decision, token, draft)), [projectId, run]);

  return { pendingKeys, create, update, transition, remove, reorder, decideSuggestion };
}
