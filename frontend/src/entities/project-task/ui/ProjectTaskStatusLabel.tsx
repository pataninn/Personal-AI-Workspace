import type { ProjectTaskStatus } from '@/entities/project-task/model/types';

const TASK_STATUS_LABELS: Readonly<Record<ProjectTaskStatus, string>> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  archived: 'Archived'
};

interface ProjectTaskStatusLabelProps {
  readonly status: ProjectTaskStatus;
}

/** Usage: Show the canonical task status as visible text alongside task details. */
export function ProjectTaskStatusLabel({ status }: ProjectTaskStatusLabelProps): React.JSX.Element {
  return <span className={`project-task-status project-task-status-${status}`}>{TASK_STATUS_LABELS[status]}</span>;
}
