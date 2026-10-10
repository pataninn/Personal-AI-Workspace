import { useEffect } from 'react';

import { useTaskManager } from '@/features/project-tasks/model/use-task-manager';
import { ProjectTaskFilters } from '@/features/project-tasks/ui/ProjectTaskFilters';
import { ProjectTaskList } from '@/features/project-tasks/ui/ProjectTaskList';
import { ProjectTaskLoading } from '@/features/project-tasks/ui/ProjectTaskLoading';
import { ProjectTaskSuggestions } from '@/features/project-tasks/ui/ProjectTaskSuggestions';
import { TaskConfirmationDialog } from '@/features/project-tasks/ui/TaskConfirmationDialog';
import { TaskEditorDialog } from '@/features/project-tasks/ui/TaskEditorDialog';
import { Alert, Button } from '@/shared/ui';

interface ProjectTasksManagerProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly archived?: boolean;
  readonly conversationId?: string | null;
  readonly compact?: boolean;
  readonly targetTaskId?: string | null;
}

/** Compose task actions and the active conversation's suggestions in one workspace panel. */
export function ProjectTasksManager({ projectId, projectName, archived = false, conversationId = null, compact = false, targetTaskId = null }: ProjectTasksManagerProps): React.JSX.Element {
  const manager = useTaskManager(projectId, conversationId ?? '', archived);
  const { setFilter, setPanel } = manager;
  useEffect(() => {
    if (targetTaskId) { setFilter('all'); setPanel('tasks'); }
  }, [targetTaskId, setFilter, setPanel]);
  const { taskList, actions, editor, deleteTarget, dismissTarget } = manager;
  const deleteBusy = deleteTarget !== null && actions.pendingKeys.includes(`task:${deleteTarget.id}`);
  const dismissBusy = dismissTarget !== null && actions.pendingKeys.includes(`suggestion:${dismissTarget.id}`);
  const editorBusy = editor !== null && actions.pendingKeys.includes(editor.kind === 'suggestion' ? `suggestion:${editor.suggestion.id}` : editor.task ? `task:${editor.task.id}` : 'create');
  return (
    <section className={compact ? 'compact-task-manager min-w-0 space-y-3' : 'project-tasks-manager space-y-4'} data-testid="project-tasks-manager" aria-label={`Tasks for ${projectName}`}>
      {compact ? <header className="compact-tasks-heading"><h2>Tasks</h2><span className="reference-count">{String(taskList.tasks.length).padStart(2, '0')}</span></header> : null}
      {archived ? <Alert tone="warning">This project is read-only.</Alert> : null}
      <p className="sr-only" data-testid="project-tasks-announcement" role="status" aria-live="polite">{manager.announcement}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Task panel">
          <Button type="button" variant={manager.panel === 'tasks' ? 'primary' : 'ghost'} aria-pressed={manager.panel === 'tasks'} onClick={() => { manager.setPanel('tasks'); }}>Tasks</Button>
          <Button type="button" variant={manager.panel === 'suggested' ? 'primary' : 'ghost'} aria-pressed={manager.panel === 'suggested'} onClick={() => { manager.setPanel('suggested'); }}>Suggested ({manager.pendingSuggestions.length})</Button>
        </div>
        <Button type="button" data-testid="project-task-add" disabled={archived || !manager.csrfToken || actions.pendingKeys.includes('create')} onClick={() => { manager.setEditor({ kind: 'task', task: null }); }}>Add task</Button>
      </div>
      {manager.panel === 'tasks' ? <>
        <ProjectTaskFilters value={manager.filter} onChange={manager.setFilter} />
        <p className="text-xs text-[var(--color-text-muted)]">Nearest deadline first, then importance.</p>
        <div data-testid="project-task-results" aria-busy={taskList.status === 'loading' || undefined}>
          {(taskList.status === 'loading' || taskList.status === 'idle') && taskList.tasks.length === 0 ? <ProjectTaskLoading /> : null}
          {taskList.status === 'error' ? <div role="alert"><p>Project tasks could not be loaded.</p><Button type="button" variant="secondary" onClick={() => { void taskList.reload(); }}>Try again</Button></div> : null}
          {taskList.status === 'success' && taskList.tasks.length === 0 ? <p className="py-4 text-sm text-[var(--color-text-muted)]" data-testid="project-task-empty">{manager.filter === 'open' ? 'No open tasks. Add a task to plan your next step.' : 'No tasks match this filter.'}</p> : null}
          {(taskList.status === 'success' || taskList.status === 'loading') && taskList.tasks.length > 0 ? <ProjectTaskList targetTaskId={targetTaskId} tasks={taskList.tasks} pendingKeys={actions.pendingKeys} archivedProject={archived} actionErrors={manager.taskErrors} onEdit={(task) => { manager.setEditor({ kind: 'task', task }); }} onTransition={manager.transition} onDelete={manager.setDeleteTarget} onToggleSubtask={manager.toggleSubtask} /> : null}
        </div>
      </> : !conversationId ? <p className="text-sm text-[var(--color-text-muted)]">Open a conversation to see its suggested tasks.</p>
        : manager.suggestionList.status === 'success' && manager.pendingSuggestions.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">No pending suggestions in this conversation.</p>
          : <ProjectTaskSuggestions projectId={projectId} suggestions={manager.pendingSuggestions} status={manager.suggestionList.status} pendingKeys={actions.pendingKeys} archivedProject={archived} errors={manager.suggestionErrors} onReview={(suggestion) => { manager.setEditor({ kind: 'suggestion', suggestion }); }} onDismiss={manager.setDismissTarget} onRetry={() => { void manager.suggestionList.reload(); }} />}
      {editor ? <TaskEditorDialog key={editor.kind === 'suggestion' ? editor.suggestion.id : editor.task?.id ?? 'new'} target={editor} saving={editorBusy} onOpenChange={(open) => { if (!open) { manager.setEditor(null); } }} onSave={manager.saveEditor} /> : null}
      <TaskConfirmationDialog open={deleteTarget !== null} title="Delete this task permanently?" description={`“${deleteTarget?.title ?? ''}” and its checklist will be removed. This cannot be undone.`} confirmLabel="Delete task" error={deleteTarget ? manager.taskErrors[deleteTarget.id] : undefined} pending={deleteBusy} testId="project-task-delete-confirmation" onOpenChange={(open) => { if (!open && !deleteBusy) { manager.setDeleteTarget(null); } }} onConfirm={() => { void manager.removeTask(); }} />
      <TaskConfirmationDialog open={dismissTarget !== null} title="Dismiss this suggestion?" description={`“${dismissTarget?.title ?? ''}” will leave pending suggestions. Its conversation history remains available.`} confirmLabel="Dismiss suggestion" pending={dismissBusy} testId="project-task-suggestion-confirmation" onOpenChange={(open) => { if (!open && !dismissBusy) { manager.setDismissTarget(null); } }} onConfirm={() => { void manager.dismissSuggestion(); }} />
    </section>
  );
}
