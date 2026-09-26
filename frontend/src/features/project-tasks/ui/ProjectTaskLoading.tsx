import { Skeleton } from '@/shared/ui';

/** Usage: Reserve list space while project tasks are fetched without showing an empty state. */
export function ProjectTaskLoading(): React.JSX.Element {
  return <div className="project-task-loading" data-testid="project-task-loading" aria-busy="true"><p role="status">Loading project tasks…</p><Skeleton className="project-task-skeleton" /><Skeleton className="project-task-skeleton" /></div>;
}
