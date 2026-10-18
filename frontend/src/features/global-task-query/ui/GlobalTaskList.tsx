import { Link } from 'react-router-dom';

import { ProjectTaskStatusLabel, TASK_IMPORTANCE_LABELS, formatTaskDeadline } from '@/entities/project-task';
import type { GlobalTaskItem } from '@/entities/project-task';
import { Button, Skeleton } from '@/shared/ui';

interface GlobalTaskListProps {
  readonly items: readonly GlobalTaskItem[];
  readonly includeArchived: boolean;
  readonly status: 'idle' | 'loading' | 'success' | 'error';
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly loadMoreError: unknown | null;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
}

export function GlobalTaskList({ items, includeArchived, status, nextCursor, loadingMore, loadMoreError, onLoadMore, onRetry }: GlobalTaskListProps): React.JSX.Element {
  if (status === 'idle' || status === 'loading') {
    return <section aria-busy="true" data-testid="global-task-loading"><p role="status">Loading tasks…</p><Skeleton className="project-task-skeleton" /><Skeleton className="project-task-skeleton" /></section>;
  }
  if (status === 'error') {
    return <section role="alert" className="error-state" data-testid="global-task-error"><h2>Tasks could not be loaded</h2><p>Try again to reload the task list.</p><Button type="button" variant="secondary" onClick={onRetry}>Try again</Button></section>;
  }
  return <section aria-label="Task results" data-testid="global-task-results">
    <ul className="global-task-list" aria-label="Tasks">
      {items.map((item) => <li key={item.task.id}>
        <Link className="global-task-row" to={`/tasks/${encodeURIComponent(item.task.id)}${includeArchived || item.task.status === 'archived' ? '?includeArchived=true' : ''}`}>
          <span className="global-task-primary"><strong>{item.task.title}</strong>{item.task.status === 'archived' ? <span className="global-task-archived">Archived</span> : null}
            <span className="supporting-copy">{item.workspace?.name ?? 'Unassigned'}</span></span>
          <span className="global-task-metadata"><ProjectTaskStatusLabel status={item.task.status} /><span>{TASK_IMPORTANCE_LABELS[item.task.importance]}</span><span>{item.task.deadline ? formatTaskDeadline(item.task.deadline) : 'No deadline'}</span></span>
        </Link>
      </li>)}
    </ul>
    {loadMoreError ? <div role="alert" className="global-task-load-more-error"><p>More tasks could not be loaded. Your current results are still available.</p><Button type="button" variant="secondary" onClick={onRetry}>Retry loading more</Button></div> : null}
    {nextCursor ? <Button type="button" variant="secondary" data-testid="global-task-load-more" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? 'Loading…' : 'Load more'}</Button> : null}
  </section>;
}
