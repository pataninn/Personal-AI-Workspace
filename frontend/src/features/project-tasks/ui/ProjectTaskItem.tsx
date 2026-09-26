import { ProjectTaskStatusLabel } from '@/entities/project-task';
import type { ProjectTask, ProjectTaskFilter, ProjectTaskStatus } from '@/entities/project-task';
import { Button, Card, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from '@/shared/ui';

interface ProjectTaskItemProps {
  readonly task: ProjectTask;
  readonly filter: ProjectTaskFilter;
  readonly index: number;
  readonly count: number;
  readonly pending: boolean;
  readonly archivedProject: boolean;
  readonly actionError: string | null;
  readonly onEdit: (task: ProjectTask) => void;
  readonly onTransition: (task: ProjectTask, status: ProjectTaskStatus) => void;
  readonly onMove: (task: ProjectTask, direction: 'up' | 'down') => void;
}

/** Usage: Render one persisted task with labelled keyboard ordering and status actions in the project list. */
export function ProjectTaskItem({ task, filter, index, count, pending, archivedProject, actionError, onEdit, onTransition, onMove }: ProjectTaskItemProps): React.JSX.Element {
  const isArchivedTask = task.status === 'archived';
  const mutable = !archivedProject && !isArchivedTask && !pending;
  const canComplete = task.status === 'todo' || task.status === 'in_progress';
  const filterMessageId = `task-${task.id}-reorder-filter-help`;
  const upMessageId = `task-${task.id}-reorder-up-help`;
  const downMessageId = `task-${task.id}-reorder-down-help`;
  const disabledReason = archivedProject ? 'This project is archived.' : isArchivedTask ? 'Archived tasks cannot be changed.' : pending ? 'A task update is in progress.' : 'Change the filter to All to reorder the complete project list.';
  const filterDisabled = filter !== 'all';
  const upDisabled = !mutable || filterDisabled || index === 0;
  const downDisabled = !mutable || filterDisabled || index === count - 1;

  return (
    <li className="project-task-list-item" data-testid={`project-task-row-${task.id}`} aria-busy={pending || undefined}>
      <Card className="project-task-card">
        <div className="project-task-main">
          <div className="project-task-heading">
            <h2>{task.title}</h2>
            <ProjectTaskStatusLabel status={task.status} />
          </div>
          {task.details ? <p className="project-task-details">{task.details}</p> : null}
          <p className="project-task-source">{task.source.label}</p>
          {actionError ? <p className="project-task-row-error" role="alert">{actionError}</p> : null}
          <span id={filterMessageId} className="sr-only">Change the filter to All to reorder the complete project list.</span>
          <span id={upMessageId} className="sr-only">{index === 0 ? 'This is already the first task.' : disabledReason}</span>
          <span id={downMessageId} className="sr-only">{index === count - 1 ? 'This is already the last task.' : disabledReason}</span>
        </div>
        <div className="project-task-controls">
          <div className="project-task-order-controls" aria-label={`Order controls for ${task.title}`}>
            <Button
              type="button"
              variant="secondary"
              data-testid={`project-task-move-up-${task.id}`}
              aria-label={`Move “${task.title}” up`}
              aria-describedby={upDisabled ? `${upMessageId}${filterDisabled ? ` ${filterMessageId}` : ''}` : undefined}
              disabled={upDisabled}
              onClick={() => { onMove(task, 'up'); }}
            >Move up</Button>
            <Button
              type="button"
              variant="secondary"
              data-testid={`project-task-move-down-${task.id}`}
              aria-label={`Move “${task.title}” down`}
              aria-describedby={downDisabled ? `${downMessageId}${filterDisabled ? ` ${filterMessageId}` : ''}` : undefined}
              disabled={downDisabled}
              onClick={() => { onMove(task, 'down'); }}
            >Move down</Button>
          </div>
          {canComplete ? <Button type="button" data-testid={`project-task-complete-${task.id}`} disabled={!mutable} aria-describedby={archivedProject ? `project-tasks-archived-readonly` : undefined} onClick={() => { onTransition(task, 'done'); }}>Mark complete</Button> : null}
          <DropdownMenuRoot>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" data-testid={`project-task-actions-${task.id}`} aria-label={`Actions for ${task.title}`} disabled={archivedProject || isArchivedTask || pending}>More actions</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Task actions</DropdownMenuLabel>
              <DropdownMenuItem data-testid={`project-task-edit-${task.id}`} onSelect={() => { onEdit(task); }}>Edit task</DropdownMenuItem>
              {task.status === 'todo' ? <DropdownMenuItem data-testid={`project-task-start-${task.id}`} onSelect={() => { onTransition(task, 'in_progress'); }}>Mark in progress</DropdownMenuItem> : null}
              {task.status === 'in_progress' ? <DropdownMenuItem data-testid={`project-task-block-${task.id}`} onSelect={() => { onTransition(task, 'blocked'); }}>Mark blocked</DropdownMenuItem> : null}
              {task.status === 'blocked' ? <DropdownMenuItem data-testid={`project-task-resume-${task.id}`} onSelect={() => { onTransition(task, 'in_progress'); }}>Resume task</DropdownMenuItem> : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem data-testid={`project-task-archive-${task.id}`} onSelect={() => { onTransition(task, 'archived'); }}>Archive task</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuRoot>
          {archivedProject ? <span className="project-task-action-help">{disabledReason}</span> : null}
        </div>
      </Card>
    </li>
  );
}
