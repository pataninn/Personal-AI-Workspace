import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { getGlobalTask } from '@/entities/project-task';
import type { GlobalTaskItem } from '@/entities/project-task';
import { ProjectTaskStatusLabel, TASK_IMPORTANCE_LABELS, formatTaskDeadline } from '@/entities/project-task';
import { Alert, ErrorState, Skeleton } from '@/shared/ui';

type DetailState = { readonly taskId: string; readonly includeArchived: boolean; readonly status: 'loading' | 'success' | 'error'; readonly item: GlobalTaskItem | null };

export function TaskDetailPage(): React.JSX.Element {
  const { taskId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const includeArchived = searchParams.get('includeArchived') === 'true';
  const [state, setState] = useState<DetailState>({ taskId: '', includeArchived: false, status: 'loading', item: null });

  useEffect(() => {
    let active = true;
    setState({ taskId, includeArchived, status: 'loading', item: null });
    void getGlobalTask(taskId, includeArchived).then((item) => {
      if (active) setState({ taskId, includeArchived, status: 'success', item });
    }).catch(() => {
      if (active) setState({ taskId, includeArchived, status: 'error', item: null });
    });
    return () => { active = false; };
  }, [taskId, includeArchived]);

  const path = `/tasks${includeArchived ? '?includeArchived=true' : ''}`;
  const current = state.taskId === taskId && state.includeArchived === includeArchived ? state : null;
  if (!current || current.status === 'loading') {
    return <section className="task-detail-page" aria-busy="true" data-testid="task-detail-loading"><p role="status">Loading task…</p><Skeleton className="project-heading-skeleton" /></section>;
  }
  if (current.status === 'error' || !current.item) {
    return <ErrorState title="Task could not be loaded" detail="This task may have moved or is no longer available." testId="task-detail-error" action={<Link className="button button-secondary" to={path}>Back to tasks</Link>} />;
  }

  const { task, workspace } = current.item;
  return <article className="task-detail-page" data-testid="task-detail-page">
    <header className="task-detail-header"><div><p className="product-label">{workspace?.name ?? 'Inbox'}{workspace?.status === 'archived' ? ' · Archived workspace' : ''}</p><h1>{task.title}</h1></div><Link className="button button-secondary" to={path}>Back to tasks</Link></header>
    {task.status === 'archived' ? <Alert tone="warning" data-testid="task-detail-archived">This task is archived and shown as historical read-only information.</Alert> : null}
    <dl className="task-detail-fields">
      <div><dt>Status</dt><dd><ProjectTaskStatusLabel status={task.status} /></dd></div>
      <div><dt>Importance</dt><dd>{TASK_IMPORTANCE_LABELS[task.importance]}</dd></div>
      <div><dt>Deadline</dt><dd>{task.deadline ? formatTaskDeadline(task.deadline) : 'No deadline'}</dd></div>
      <div><dt>Location</dt><dd>{workspace ? `${workspace.name}${workspace.status === 'archived' ? ' (archived workspace)' : ''}` : 'Inbox'}</dd></div>
    </dl>
    {task.details ? <section aria-labelledby="task-detail-details-heading"><h2 id="task-detail-details-heading">Details</h2><p className="task-detail-copy">{task.details}</p></section> : null}
    {task.subtasks.length ? <section aria-labelledby="task-detail-checklist-heading"><h2 id="task-detail-checklist-heading">Checklist</h2><ul className="task-detail-checklist">{task.subtasks.map((subtask) => <li key={subtask.id}><span>{subtask.completed ? 'Completed' : 'Open'}</span> {subtask.title}</li>)}</ul></section> : null}
    <p className="supporting-copy">Task details are read-only here. Use the workspace task list for existing project actions.</p>
  </article>;
}
