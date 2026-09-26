import { useState } from 'react';

import { useAppSelector } from '@/app/store/hooks';
import { listProjectTasks, useProjectTaskSuggestions, useProjectTasks } from '@/entities/project-task';
import type { ProjectTask, ProjectTaskDraft, ProjectTaskFilter, ProjectTaskStatus, ProjectTaskSuggestion } from '@/entities/project-task';
import { selectCsrfToken } from '@/entities/user-session';
import { useProjectTaskActions } from '@/features/project-tasks/model/use-project-task-actions';
import { Alert, Button } from '@/shared/ui';
import { ApiClientError } from '@/shared/api';
import { ProjectTaskFilters } from '@/features/project-tasks/ui/ProjectTaskFilters';
import { ProjectTaskList } from '@/features/project-tasks/ui/ProjectTaskList';
import { ProjectTaskLoading } from '@/features/project-tasks/ui/ProjectTaskLoading';
import { ProjectTaskSuggestions } from '@/features/project-tasks/ui/ProjectTaskSuggestions';
import { TaskConfirmationDialog } from '@/features/project-tasks/ui/TaskConfirmationDialog';
import { TaskEditorDialog } from '@/features/project-tasks/ui/TaskEditorDialog';
import type { TaskEditorSaveResult, TaskEditorTarget } from '@/features/project-tasks/ui/TaskEditorDialog';

interface ProjectTasksManagerProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly archived: boolean;
}

type TerminalTaskTransition = { readonly task: ProjectTask; readonly status: 'done' | 'archived' };

/** Usage: Compose project-scoped task loading, explicit task actions, and independent pending suggestions. */
export function ProjectTasksManager({ projectId, projectName, archived }: ProjectTasksManagerProps): React.JSX.Element {
  const csrfToken = useAppSelector(selectCsrfToken);
  const [filter, setFilter] = useState<ProjectTaskFilter>('all');
  const [editor, setEditor] = useState<TaskEditorTarget | null>(null);
  const [terminalTransition, setTerminalTransition] = useState<TerminalTaskTransition | null>(null);
  const [dismissTarget, setDismissTarget] = useState<ProjectTaskSuggestion | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [taskActionErrors, setTaskActionErrors] = useState<Readonly<Record<string, string>>>({});
  const [suggestionErrors, setSuggestionErrors] = useState<Readonly<Record<string, string>>>({});
  const taskList = useProjectTasks(projectId, filter);
  const suggestionList = useProjectTaskSuggestions(projectId);
  const actions = useProjectTaskActions(projectId, csrfToken);
  const disabledReasonId = 'project-tasks-archived-readonly';
  const createBusy = actions.pendingKeys.includes('create');
  const confirmBusy = terminalTransition ? actions.pendingKeys.includes(`task:${terminalTransition.task.id}`)
    : dismissTarget ? actions.pendingKeys.includes(`suggestion:${dismissTarget.id}`) : false;

  function openCreate(): void {
    setEditor({ kind: 'task', task: null });
  }

  function openEdit(task: ProjectTask): void {
    setEditor({ kind: 'task', task });
  }

  function openSuggestion(suggestion: ProjectTaskSuggestion): void {
    setEditor({ kind: 'suggestion', suggestion });
  }

  async function saveEditor(draft: ProjectTaskDraft, idempotencyKey: string, expectedVersion: number | null): Promise<TaskEditorSaveResult> {
    if (archived || !editor) {
      return { status: 'error', message: 'This project is read-only.' };
    }
    try {
      if (editor.kind === 'suggestion') {
        const result = await actions.decideSuggestion(editor.suggestion, 'accepted', draft);
        if (!result.task) {
          return { status: 'error', message: 'The suggestion could not be added. Try again.' };
        }
        suggestionList.removeSuggestion(editor.suggestion.id);
        setSuggestionErrors((current) => withoutKey(current, editor.suggestion.id));
        addConfirmedTask(result.task);
        setAnnouncement('Task added to this project');
        void suggestionList.reload();
        return { status: 'saved' };
      }
      if (editor.task) {
        await actions.update(editor.task, draft, expectedVersion ?? editor.task.version);
        setTaskActionErrors((current) => withoutKey(current, editor.task?.id ?? ''));
        setAnnouncement('Changes saved');
        void taskList.reload();
        return { status: 'saved' };
      }
      await actions.create(draft, idempotencyKey);
      setAnnouncement('Task added');
      if (filter !== 'all') {
        setFilter('all');
      } else {
        void taskList.reload();
      }
      return { status: 'saved' };
    } catch (error: unknown) {
      if (editor.kind === 'task' && editor.task && isTaskVersionConflict(error)) {
        return { status: 'conflict', latest: await findLatestTask(editor.task) };
      }
      if (editor.kind === 'suggestion' && isSuggestionConflict(error)) {
        void suggestionList.reload();
        return { status: 'error', message: 'This suggestion changed or was already resolved. Pending suggestions have been refreshed.' };
      }
      return mapEditorError(error);
    }
  }

  function addConfirmedTask(task: ProjectTask): void {
    if (filter !== 'all') {
      setFilter('all');
      return;
    }
    taskList.upsertTask(task);
    void taskList.reload();
  }

  async function moveTask(task: ProjectTask, direction: 'up' | 'down'): Promise<void> {
    if (archived || filter !== 'all' || taskList.orderVersion === null) {
      return;
    }
    setTaskActionErrors((current) => withoutKey(current, task.id));
    try {
      const reordered = await actions.reorder(task.id, direction, taskList.orderVersion);
      taskList.replaceTasks(reordered);
      const updated = reordered.tasks.find((candidate) => candidate.id === task.id);
      setAnnouncement(updated ? `“${updated.title}” moved to position ${updated.position + 1}.` : 'Task order updated');
    } catch (error: unknown) {
      if (isOrderConflict(error)) {
        await taskList.reload();
        setTaskActionErrors((current) => ({ ...current, [task.id]: 'The task order changed elsewhere. The list has been refreshed; try again.' }));
      } else {
        setTaskActionErrors((current) => ({ ...current, [task.id]: 'Task order could not be saved. Try again.' }));
      }
    }
  }

  function requestTransition(task: ProjectTask, status: ProjectTaskStatus): void {
    if (archived) {
      return;
    }
    if (status === 'done' || status === 'archived') {
      setTerminalTransition({ task, status });
      return;
    }
    void saveStatus(task, status);
  }

  async function saveStatus(task: ProjectTask, status: ProjectTaskStatus): Promise<void> {
    setTaskActionErrors((current) => withoutKey(current, task.id));
    try {
      await actions.transition(task, status);
      setAnnouncement(statusAnnouncement(task, status));
      setTerminalTransition(null);
      void taskList.reload();
    } catch (error: unknown) {
      if (isTaskVersionConflict(error) || isTaskStatusConflict(error)) {
        await taskList.reload();
        setTaskActionErrors((current) => ({ ...current, [task.id]: 'This task changed elsewhere. The list has been refreshed; review it before trying again.' }));
      } else {
        setTaskActionErrors((current) => ({ ...current, [task.id]: mapMutationError(error) }));
      }
    }
  }

  async function confirmTerminalTransition(): Promise<void> {
    if (!terminalTransition || archived) {
      return;
    }
    await saveStatus(terminalTransition.task, terminalTransition.status);
  }

  async function dismissSuggestion(): Promise<void> {
    if (!dismissTarget || archived) {
      return;
    }
    try {
      await actions.decideSuggestion(dismissTarget, 'dismissed');
      suggestionList.removeSuggestion(dismissTarget.id);
      setSuggestionErrors((current) => withoutKey(current, dismissTarget.id));
      setDismissTarget(null);
      setAnnouncement('Suggestion dismissed');
      void suggestionList.reload();
    } catch (error: unknown) {
      if (isSuggestionConflict(error)) {
        void suggestionList.reload();
      }
      setSuggestionErrors((current) => ({ ...current, [dismissTarget.id]: 'Could not dismiss this suggestion. Try again.' }));
      setDismissTarget(null);
    }
  }

  async function retryTaskList(): Promise<void> {
    await taskList.reload();
  }

  return (
    <section className="project-tasks-manager" data-testid="project-tasks-manager" aria-label={`Tasks for ${projectName}`}>
      {archived ? <Alert id={disabledReasonId} tone="warning" data-testid="project-tasks-archived-message">This project is archived. Tasks are available to review, but you cannot change them or create new tasks.</Alert> : null}
      <p className="project-tasks-announcement" data-testid="project-tasks-announcement" role="status" aria-live="polite">{announcement}</p>
      <div className="project-tasks-toolbar">
        <p>Track work for this project. Tasks do not run automatically.</p>
        <Button type="button" data-testid="project-task-add" disabled={archived || createBusy || !csrfToken} aria-describedby={archived ? disabledReasonId : undefined} onClick={openCreate}>Add task</Button>
      </div>
      <ProjectTaskFilters value={filter} onChange={setFilter} />
      {filter !== 'all' ? <p className="project-task-filter-help">Reordering is available in All and changes the full project order.</p> : null}
      <div className="project-task-results" data-testid="project-task-results" aria-busy={taskList.status === 'loading' || undefined}>
        {taskList.status === 'idle' || taskList.status === 'loading' ? <ProjectTaskLoading /> : null}
        {taskList.status === 'error' ? <section className="project-task-error" data-testid="project-task-error" role="alert"><h2>Project tasks could not be loaded</h2><p>We could not load the tasks for this project. Try again.</p><Button type="button" variant="secondary" data-testid="project-task-retry" onClick={() => { void retryTaskList(); }}>Try again</Button></section> : null}
        {taskList.status === 'success' && taskList.tasks.length === 0 ? <ProjectTaskEmpty filter={filter} onShowAll={() => { setFilter('all'); }} onAdd={openCreate} archived={archived} /> : null}
        {taskList.status === 'success' && taskList.tasks.length > 0 ? <ProjectTaskList tasks={taskList.tasks} filter={filter} pendingKeys={actions.pendingKeys} archivedProject={archived} actionErrors={taskActionErrors} onEdit={openEdit} onTransition={requestTransition} onMove={(task, direction) => { void moveTask(task, direction); }} /> : null}
      </div>
      <ProjectTaskSuggestions projectId={projectId} suggestions={suggestionList.suggestions} status={suggestionList.status} pendingKeys={actions.pendingKeys} archivedProject={archived} errors={suggestionErrors} onReview={openSuggestion} onDismiss={setDismissTarget} onRetry={() => { void suggestionList.reload(); }} />
      {editor ? <TaskEditorDialog key={editorKey(editor)} target={editor} saving={actions.pendingKeys.includes(editor.kind === 'task' ? (editor.task ? `task:${editor.task.id}` : 'create') : `suggestion:${editor.suggestion.id}`)} onOpenChange={(open) => { if (!open) { setEditor(null); } }} onSave={saveEditor} /> : null}
      <TaskConfirmationDialog
        open={terminalTransition !== null}
        title={terminalTransition?.status === 'done' ? 'Mark this task complete?' : 'Archive this task?'}
        description={terminalTransition?.status === 'done' ? `“${terminalTransition.task.title}” will move to Completed. You can still view it there.` : `“${terminalTransition?.task.title ?? ''}” will be archived and removed from the active task order.`}
        confirmLabel={terminalTransition?.status === 'done' ? 'Mark complete' : 'Archive task'}
        pending={confirmBusy}
        testId="project-task-status-confirmation"
        onOpenChange={(open) => { if (!open && !confirmBusy) { setTerminalTransition(null); } }}
        onConfirm={() => { void confirmTerminalTransition(); }}
      />
      <TaskConfirmationDialog
        open={dismissTarget !== null}
        title="Dismiss this suggestion?"
        description={`“${dismissTarget?.title ?? ''}” will leave the pending suggestions list. Its conversation history will remain available.`}
        confirmLabel="Dismiss suggestion"
        pending={confirmBusy}
        testId="project-task-suggestion-confirmation"
        onOpenChange={(open) => { if (!open && !confirmBusy) { setDismissTarget(null); } }}
        onConfirm={() => { void dismissSuggestion(); }}
      />
    </section>
  );

  async function findLatestTask(task: ProjectTask): Promise<ProjectTask | null> {
    try {
      const [active, archivedList] = await Promise.all([listProjectTasks(projectId, 'all'), listProjectTasks(projectId, 'archived')]);
      return [...active.tasks, ...archivedList.tasks].find((candidate) => candidate.id === task.id) ?? null;
    } catch {
      return null;
    }
  }
}

function ProjectTaskEmpty({ filter, onShowAll, onAdd, archived }: {
  readonly filter: ProjectTaskFilter;
  readonly onShowAll: () => void;
  readonly onAdd: () => void;
  readonly archived: boolean;
}): React.JSX.Element {
  if (filter !== 'all') {
    return <section className="empty-state project-task-empty" data-testid="project-task-filter-empty"><h2>No tasks match this filter</h2><p>Show all project tasks to review the complete list.</p><Button type="button" variant="secondary" data-testid="project-task-empty-show-all" onClick={onShowAll}>Show all tasks</Button></section>;
  }
  return <section className="empty-state project-task-empty" data-testid="project-task-empty"><h2>No tasks yet</h2><p>Add a task to plan the next piece of work. Tasks do not run automatically.</p><Button type="button" data-testid="project-task-empty-add" disabled={archived} onClick={onAdd}>Add task</Button></section>;
}

function mapEditorError(error: unknown): TaskEditorSaveResult {
  if (error instanceof ApiClientError) {
    const fieldErrors = Object.fromEntries(error.details.filter((detail) => detail.field === 'title' || detail.field === 'details').map((detail) => [detail.field, detail.message]));
    if (Object.keys(fieldErrors).length > 0) {
      return { status: 'error', message: 'Check the highlighted fields and try again.', fieldErrors };
    }
  }
  return { status: 'error', message: 'The task could not be saved. Check the fields and try again.' };
}

function mapMutationError(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'PROJECT_ARCHIVED') {
    return 'This project is archived. Tasks are read-only.';
  }
  if (error instanceof ApiClientError && error.code === 'PROJECT_TASK_ARCHIVED') {
    return 'This task has been archived and cannot be changed.';
  }
  return 'The task update could not be saved. Try again.';
}

function isTaskVersionConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.statusCode === 409 && error.code === 'PROJECT_TASK_VERSION_CONFLICT';
}

function isTaskStatusConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.statusCode === 409 && error.code === 'PROJECT_TASK_STATUS_CONFLICT';
}

function isOrderConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.statusCode === 409 && (error.code === 'PROJECT_TASK_ORDER_CONFLICT' || error.code === 'PROJECT_TASK_ORDER_BOUNDARY');
}

function isSuggestionConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.statusCode === 409 && (error.code === 'PROJECT_TASK_SUGGESTION_RESOLVED' || error.code === 'PROJECT_TASK_VERSION_CONFLICT');
}

function statusAnnouncement(task: ProjectTask, status: ProjectTaskStatus): string {
  if (status === 'done') {
    return `“${task.title}” marked complete`;
  }
  if (status === 'archived') {
    return `“${task.title}” archived`;
  }
  if (status === 'blocked') {
    return `“${task.title}” marked blocked`;
  }
  return `“${task.title}” moved to In progress`;
}

function editorKey(target: TaskEditorTarget): string {
  return target.kind === 'suggestion' ? `suggestion-${target.suggestion.id}` : `task-${target.task?.id ?? 'new'}`;
}

function withoutKey(values: Readonly<Record<string, string>>, key: string): Readonly<Record<string, string>> {
  const next = { ...values };
  delete next[key];
  return next;
}
