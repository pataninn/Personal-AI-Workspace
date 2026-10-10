import { useEffect, useRef } from 'react';

import { formatTaskDeadline, isTaskOverdue, ProjectTaskStatusLabel, TASK_IMPORTANCE_LABELS } from '@/entities/project-task';
import type { ProjectTask, ProjectTaskStatus } from '@/entities/project-task';
import { Button, DropdownMenuContent, DropdownMenuItem, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from '@/shared/ui';

interface ProjectTaskItemProps {
  readonly task: ProjectTask;
  readonly pending: boolean;
  readonly archivedProject: boolean;
  readonly actionError: string | null;
  readonly onEdit: (task: ProjectTask) => void;
  readonly onTransition: (task: ProjectTask, status: ProjectTaskStatus) => void;
  readonly onDelete: (task: ProjectTask) => void;
  readonly onToggleSubtask: (task: ProjectTask, subtaskId: string) => void;
  readonly targeted?: boolean;
}

/** Compact task headings disclose details and one level of checklist items inline. */
export function ProjectTaskItem({ task, pending, archivedProject, actionError, onEdit, onTransition, onDelete, onToggleSubtask, targeted = false }: ProjectTaskItemProps): React.JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const mutable = !archivedProject && !pending;
  const completedCount = task.subtasks.filter((subtask) => subtask.completed).length;
  useEffect(() => {
    if (!targeted || !detailsRef.current || !summaryRef.current) { return; }
    detailsRef.current.open = true;
    summaryRef.current.focus();
    summaryRef.current.scrollIntoView?.({ block: 'nearest' });
  }, [targeted]);
  return (
    <li className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)]" data-testid={`project-task-row-${task.id}`} aria-busy={pending || undefined}>
      <details ref={detailsRef} className="group">
        <summary ref={summaryRef} className="cursor-pointer p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-ring)]">
          <span className="font-medium break-words">{task.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <ProjectTaskStatusLabel status={task.status} />
            <span className={`importance-label importance-${task.importance}`}>{TASK_IMPORTANCE_LABELS[task.importance]}</span>
            {task.deadline ? <span className={isTaskOverdue(task) ? 'text-[var(--color-error)]' : undefined}>{isTaskOverdue(task) ? 'Overdue · ' : 'Due '}{formatTaskDeadline(task.deadline)}</span> : null}
            {task.subtasks.length ? <span>{completedCount}/{task.subtasks.length} subtasks</span> : null}
          </span>
        </summary>
        <div className="space-y-3 border-t border-[var(--color-border)] p-3">
          {task.details ? <p className="whitespace-pre-wrap break-words text-sm">{task.details}</p> : <p className="text-sm text-[var(--color-text-muted)]">No details added.</p>}
          {task.subtasks.length ? <ul role="list" className="list-none space-y-2 p-0" aria-label={`Subtasks for ${task.title}`}>{task.subtasks.map((subtask) => (
            <li key={subtask.id}><label className="flex min-h-8 cursor-pointer items-start gap-2 text-sm"><input type="checkbox" checked={subtask.completed} disabled={!mutable} onChange={() => { onToggleSubtask(task, subtask.id); }} className="mt-1 shrink-0 accent-[var(--color-primary)]" /><span className={subtask.completed ? 'line-through text-[var(--color-text-muted)]' : 'min-w-0 break-words'}>{subtask.title}</span></label></li>
          ))}</ul> : null}
          <p className="text-xs text-[var(--color-text-muted)]">{task.source.label}</p>
          <div className="flex flex-wrap items-center gap-2">
            {task.status !== 'done' ? <Button type="button" data-testid={`project-task-complete-${task.id}`} disabled={!mutable} onClick={() => { onTransition(task, 'done'); }}>Mark complete</Button> : null}
            {task.status === 'done' && task.subtasks.length === 0 ? <Button type="button" variant="secondary" data-testid={`project-task-reopen-${task.id}`} disabled={!mutable} onClick={() => { onTransition(task, 'todo'); }}>Mark incomplete</Button> : null}
            <DropdownMenuRoot><DropdownMenuTrigger asChild><Button type="button" variant="ghost" data-testid={`project-task-actions-${task.id}`} aria-label={`Actions for ${task.title}`} disabled={!mutable}>More actions</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem data-testid={`project-task-edit-${task.id}`} onSelect={() => { onEdit(task); }}>Edit task</DropdownMenuItem>
                {task.status === 'todo' ? <DropdownMenuItem onSelect={() => { onTransition(task, 'in_progress'); }}>Mark in progress</DropdownMenuItem> : null}
                {task.status === 'in_progress' ? <DropdownMenuItem onSelect={() => { onTransition(task, 'blocked'); }}>Mark blocked</DropdownMenuItem> : null}
                {task.status === 'blocked' ? <DropdownMenuItem onSelect={() => { onTransition(task, 'in_progress'); }}>Resume task</DropdownMenuItem> : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem data-testid={`project-task-delete-${task.id}`} onSelect={() => { onDelete(task); }}>Delete task</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuRoot>
          </div>
        </div>
      </details>
      {actionError ? <p className="p-3 text-sm text-[var(--color-error)]" role="alert">{actionError}</p> : null}
    </li>
  );
}
