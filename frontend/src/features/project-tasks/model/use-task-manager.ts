import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { useAppSelector } from '@/app/store/hooks';
import { listProjectTasks, useProjectTasks } from '@/entities/project-task';
import type { ProjectTask, ProjectTaskDraft, ProjectTaskFilter, ProjectTaskStatus, ProjectTaskSuggestion } from '@/entities/project-task';
import { selectCsrfToken } from '@/entities/user-session';
import { useProjectTaskActions } from '@/features/project-tasks/model/use-project-task-actions';
import { useConversationTaskSuggestions } from '@/features/project-tasks/model/use-conversation-task-suggestions';
import type { TaskEditorSaveResult, TaskEditorTarget } from '@/features/project-tasks/ui/TaskEditorDialog';
import { ApiClientError } from '@/shared/api';

type StateSetter<T> = Dispatch<SetStateAction<T>>;

interface TaskManagerState {
  readonly csrfToken: string | null;
  readonly filter: ProjectTaskFilter;
  readonly setFilter: StateSetter<ProjectTaskFilter>;
  readonly panel: 'tasks' | 'suggested';
  readonly setPanel: StateSetter<'tasks' | 'suggested'>;
  readonly editor: TaskEditorTarget | null;
  readonly setEditor: StateSetter<TaskEditorTarget | null>;
  readonly deleteTarget: ProjectTask | null;
  readonly setDeleteTarget: StateSetter<ProjectTask | null>;
  readonly dismissTarget: ProjectTaskSuggestion | null;
  readonly setDismissTarget: StateSetter<ProjectTaskSuggestion | null>;
  readonly announcement: string;
  readonly taskErrors: Readonly<Record<string, string>>;
  readonly suggestionErrors: Readonly<Record<string, string>>;
  readonly taskList: ReturnType<typeof useProjectTasks>;
  readonly suggestionList: ReturnType<typeof useConversationTaskSuggestions>;
  readonly pendingSuggestions: readonly ProjectTaskSuggestion[];
  readonly actions: ReturnType<typeof useProjectTaskActions>;
  readonly saveEditor: (draft: ProjectTaskDraft, idempotencyKey: string, expectedVersion: number | null) => Promise<TaskEditorSaveResult>;
  readonly transition: (task: ProjectTask, status: ProjectTaskStatus) => void;
  readonly toggleSubtask: (task: ProjectTask, subtaskId: string) => void;
  readonly removeTask: () => Promise<void>;
  readonly dismissSuggestion: () => Promise<void>;
}

/** Keep versioned task mutations and conversation-scoped suggestion state in the owning feature. */
export function useTaskManager(projectId: string, conversationId: string, archived: boolean): TaskManagerState {
  const csrfToken = useAppSelector(selectCsrfToken);
  const [filter, setFilter] = useState<ProjectTaskFilter>('open');
  const [panel, setPanel] = useState<'tasks' | 'suggested'>('tasks');
  const [editor, setEditor] = useState<TaskEditorTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectTask | null>(null);
  const [dismissTarget, setDismissTarget] = useState<ProjectTaskSuggestion | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [taskErrors, setTaskErrors] = useState<Readonly<Record<string, string>>>({});
  const [suggestionErrors, setSuggestionErrors] = useState<Readonly<Record<string, string>>>({});
  const taskList = useProjectTasks(projectId, filter);
  const suggestionList = useConversationTaskSuggestions(projectId, conversationId);
  const actions = useProjectTaskActions(projectId, csrfToken);
  const pendingSuggestions = suggestionList.suggestions.filter((suggestion) => suggestion.status === 'pending');

  async function saveEditor(draft: ProjectTaskDraft, idempotencyKey: string, expectedVersion: number | null): Promise<TaskEditorSaveResult> {
    if (archived || !editor) {
      return { status: 'error', message: 'This project is read-only.' };
    }
    try {
      await persistEditor(draft, idempotencyKey, expectedVersion);
      void taskList.reload();
      return { status: 'saved' };
    } catch (error: unknown) {
      if (editor.kind === 'task' && editor.task && isTaskConflict(error)) {
        return { status: 'conflict', latest: await findLatestTask(editor.task.id) };
      }
      return { status: 'error', message: mutationError(error) };
    }
  }

  async function persistEditor(draft: ProjectTaskDraft, idempotencyKey: string, expectedVersion: number | null): Promise<void> {
    if (!editor) { return; }
    if (editor.kind === 'suggestion') {
      const result = await actions.decideSuggestion(editor.suggestion, 'accepted', draft);
      suggestionList.resolveSuggestion(result.taskSuggestion, result.task);
      setPanel('tasks');
      setAnnouncement('Suggested task added to this project.');
    } else if (editor.task) {
      await actions.update(editor.task, draft, expectedVersion ?? editor.task.version);
      setAnnouncement('Changes saved.');
    } else {
      await actions.create(draft, idempotencyKey);
      setAnnouncement('Task added.');
    }
  }

  async function applyTaskChange(task: ProjectTask, operation: () => Promise<unknown>, notice: string): Promise<void> {
    if (archived) { return; }
    setTaskErrors((current) => withoutKey(current, task.id));
    try {
      await operation();
      setAnnouncement(notice);
      void taskList.reload();
    } catch (error: unknown) {
      if (isTaskConflict(error)) { await taskList.reload(); }
      setTaskErrors((current) => ({ ...current, [task.id]: mutationError(error) }));
    }
  }

  function transition(task: ProjectTask, status: ProjectTaskStatus): void {
    void applyTaskChange(task, () => actions.transition(task, status), status === 'done' ? 'Task marked complete.' : 'Task status updated.');
  }

  function toggleSubtask(task: ProjectTask, subtaskId: string): void {
    const subtasks = task.subtasks.map((subtask) => subtask.id === subtaskId ? { ...subtask, completed: !subtask.completed } : subtask);
    const draft = { title: task.title, details: task.details, importance: task.importance, deadline: task.deadline, subtasks };
    void applyTaskChange(task, () => actions.update(task, draft, task.version), 'Checklist updated.');
  }

  async function removeTask(): Promise<void> {
    if (!deleteTarget || archived) { return; }
    const task = deleteTarget;
    try {
      await actions.remove(task);
      setDeleteTarget(null);
      setAnnouncement('Task permanently deleted.');
      void taskList.reload();
    } catch (error: unknown) {
      if (isTaskConflict(error)) { await taskList.reload(); setDeleteTarget(null); }
      setTaskErrors((current) => ({ ...current, [task.id]: mutationError(error) }));
    }
  }

  async function dismissSuggestion(): Promise<void> {
    if (!dismissTarget || archived) { return; }
    try {
      const result = await actions.decideSuggestion(dismissTarget, 'dismissed');
      suggestionList.resolveSuggestion(result.taskSuggestion, null);
      setDismissTarget(null);
      setAnnouncement('Suggestion dismissed.');
    } catch (error: unknown) {
      void suggestionList.reload();
      setSuggestionErrors((current) => ({ ...current, [dismissTarget.id]: mutationError(error) }));
      setDismissTarget(null);
    }
  }

  async function findLatestTask(taskId: string): Promise<ProjectTask | null> {
    try {
      return (await listProjectTasks(projectId, 'all')).tasks.find((task) => task.id === taskId) ?? null;
    } catch { return null; }
  }

  return { csrfToken, filter, setFilter, panel, setPanel, editor, setEditor, deleteTarget, setDeleteTarget,
    dismissTarget, setDismissTarget, announcement, taskErrors, suggestionErrors, taskList, suggestionList,
    pendingSuggestions, actions, saveEditor, transition, toggleSubtask, removeTask, dismissSuggestion };
}

function isTaskConflict(error: unknown): boolean {
  return error instanceof ApiClientError && (error.statusCode === 409 || error.statusCode === 404);
}

function mutationError(error: unknown): string {
  if (isTaskConflict(error)) { return 'This task changed elsewhere. Review the refreshed list and try again.'; }
  if (error instanceof ApiClientError && error.code === 'PROJECT_TASK_INCOMPLETE_SUBTASKS') {
    return 'Complete the checklist before finishing this task.';
  }
  return error instanceof ApiClientError ? error.message : 'The update could not be saved. Try again.';
}

function withoutKey(values: Readonly<Record<string, string>>, key: string): Readonly<Record<string, string>> {
  const next = { ...values };
  delete next[key];
  return next;
}
