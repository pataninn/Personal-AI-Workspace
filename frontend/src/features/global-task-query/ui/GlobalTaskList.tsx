import { Link } from 'react-router-dom';

import { ProjectTaskStatusLabel, TASK_IMPORTANCE_LABELS, formatTaskDeadline, isTaskOverdue } from '@/entities/project-task';
import type { GlobalTaskItem } from '@/entities/project-task';
import { Button, Icon, Skeleton } from '@/shared/ui';

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
    {items.length > 0 ? <div className="global-task-results-heading"><div><h2>Task list</h2><p>{items.length} {items.length === 1 ? 'task' : 'tasks'} shown{nextCursor ? ' · More available below' : ''}</p></div><span>Open a task to edit</span></div> : null}
    <ul className="global-task-list" aria-label="Tasks">
      {items.map((item) => <li key={item.task.id}>
        <Link className={`global-task-row global-task-priority-${item.task.importance}${item.task.status === 'done' ? ' is-complete' : ''}`} to={`/tasks/${encodeURIComponent(item.task.id)}${includeArchived ? '?includeArchived=true' : ''}`}>
          <span className="global-task-primary"><strong>{item.task.title}</strong>
            {item.task.details ? <span className="global-task-description">{item.task.details}</span> : null}
            <span className="global-task-context"><span><Icon name={item.workspace ? 'folder' : 'file'} size={14} />{item.workspace?.name ?? 'Unassigned'}</span>
              {item.workspace?.status === 'archived' ? <span className="global-task-archived">Archived workspace</span> : null}
              {item.task.subtasks.length > 0 ? <span><Icon name="check" size={14} />{item.task.subtasks.filter((subtask) => subtask.completed).length}/{item.task.subtasks.length} subtasks</span> : null}
            </span></span>
          <span className="global-task-metadata"><ProjectTaskStatusLabel status={item.task.status} />
            <span className={`global-task-priority-badge importance-${item.task.importance}`}><span className={`importance-bars importance-bars-${item.task.importance}`} aria-hidden="true"><i /><i /><i /></span>{TASK_IMPORTANCE_LABELS[item.task.importance]}</span>
            {item.task.deadline ? <span className={`global-task-deadline${isTaskOverdue(item.task) ? ' is-overdue' : ''}`}>{isTaskOverdue(item.task) ? 'Overdue · ' : 'Due ' }<time dateTime={item.task.deadline}>{formatTaskDeadline(item.task.deadline)}</time></span> : <span className="global-task-deadline is-undated">No deadline</span>}
          </span><span className="global-task-open" aria-hidden="true"><Icon name="arrow" size={18} /></span>
        </Link>
      </li>)}
    </ul>
    {loadMoreError ? <div role="alert" className="global-task-load-more-error"><p>More tasks could not be loaded. Your current results are still available.</p><Button type="button" variant="secondary" onClick={onRetry}>Retry loading more</Button></div> : null}
    {nextCursor ? <Button type="button" variant="secondary" data-testid="global-task-load-more" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? 'Loading…' : 'Load more'}</Button> : null}
  </section>;
}
