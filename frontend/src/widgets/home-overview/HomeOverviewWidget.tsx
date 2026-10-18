import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { projectColor, type ProjectSnapshot, type HomeTaskSummary } from '@/entities/project';
import { formatTaskDeadline, isTaskOverdue, TASK_IMPORTANCE_LABELS } from '@/entities/project-task';
import { HomeTaskCapture } from '@/features/task-capture';
import { Alert, Button, Card, ErrorState, Icon, Skeleton } from '@/shared/ui';

export interface HomeWorkspaceSummary {
  readonly project: ProjectSnapshot;
  readonly lastActivityAt: string | null;
}

type SummaryStatus = 'loading' | 'success' | 'error';

interface HomeOverviewWidgetProps {
  readonly tasks: readonly HomeTaskSummary[];
  readonly taskStatus: SummaryStatus;
  readonly onRetryTasks: () => void;
  readonly workspaces: readonly HomeWorkspaceSummary[];
  readonly workspaceStatus: SummaryStatus;
  readonly onRetryWorkspaces: () => void;
  readonly csrfToken?: string | null;
  readonly onTaskCreated?: () => void;
}

const TASK_STATUS_LABELS: Readonly<Record<HomeTaskSummary['status'], string>> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked'
};

/** Render the independent Home task and workspace summary sections. */
export function HomeOverviewWidget({
  tasks,
  taskStatus,
  onRetryTasks,
  workspaces,
  workspaceStatus,
  onRetryWorkspaces,
  csrfToken,
  onTaskCreated
}: HomeOverviewWidgetProps): React.JSX.Element {
  return <div className="home-overview-grid" data-testid="home-overview-widget">
    <UpNextSection tasks={tasks} status={taskStatus} onRetry={onRetryTasks} workspaces={workspaces} workspaceStatus={workspaceStatus} csrfToken={csrfToken ?? null} onTaskCreated={onTaskCreated} />
    <WorkspaceSection workspaces={workspaces} status={workspaceStatus} onRetry={onRetryWorkspaces} />
  </div>;
}

function UpNextSection({
  tasks,
  status,
  onRetry,
  workspaces,
  workspaceStatus,
  csrfToken,
  onTaskCreated
}: {
  readonly tasks: readonly HomeTaskSummary[];
  readonly status: SummaryStatus;
  readonly onRetry: () => void;
  readonly workspaces: readonly HomeWorkspaceSummary[];
  readonly workspaceStatus: SummaryStatus;
  readonly csrfToken: string | null;
  readonly onTaskCreated?: () => void;
}): React.JSX.Element {
  const [captureOpen, setCaptureOpen] = useState(false);
  const addTaskButtonRef = useRef<HTMLButtonElement>(null);
  const captureWorkspaces = workspaces.map(({ project }) => project);
  function toggleCapture(): void {
    if (captureOpen) addTaskButtonRef.current?.focus();
    setCaptureOpen((open) => !open);
  }
  function closeCapture(): void {
    setCaptureOpen(false);
    addTaskButtonRef.current?.focus();
  }
  return <section aria-labelledby="home-up-next-heading" aria-busy={status === 'loading'} data-testid="home-up-next-section">
    <Card className="home-task-card">
      <header className="home-section-heading !flex-wrap">
        <h2 id="home-up-next-heading">Up next</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button ref={addTaskButtonRef} type="button" data-testid="home-add-task-toggle" aria-expanded={captureOpen} aria-controls="home-task-capture-form" onClick={toggleCapture}>Add task</Button>
          <Button asChild variant="secondary"><Link to="/tasks" data-testid="home-view-all-tasks">View all tasks</Link></Button>
        </div>
      </header>
      <HomeTaskCapture isOpen={captureOpen} csrfToken={csrfToken} workspaces={captureWorkspaces} workspaceStatus={workspaceStatus} onCreated={onTaskCreated} onClose={closeCapture} />
      {status === 'loading' && tasks.length === 0 ? <div aria-busy="true"><p className="sr-only" role="status">Loading Up next tasks</p><Skeleton className="project-task-skeleton" /></div> : null}
      {status === 'loading' && tasks.length > 0 ? <p className="sr-only" role="status">Refreshing Up next tasks</p> : null}
      {status === 'error' ? <Alert tone="error" data-testid="home-up-next-error"><p>{tasks.length ? 'Up next could not be refreshed. Showing the last loaded tasks.' : 'Up next is unavailable.'}</p><Button type="button" variant="secondary" data-testid="home-up-next-retry" onClick={onRetry}>Try again</Button></Alert> : null}
      {status === 'success' && tasks.length === 0 ? <p className="supporting-copy home-tasks-empty" data-testid="home-tasks-empty">No open tasks yet. Add a task to plan your next step.</p> : null}
      {tasks.length > 0 ? <ul className="home-task-list" data-testid="home-task-list">{tasks.map((task) => <TaskSummaryRow key={task.id} task={task} />)}</ul> : null}
    </Card>
  </section>;
}

function TaskSummaryRow({ task }: { readonly task: HomeTaskSummary }): React.JSX.Element {
  return <li><Link to={`/tasks/${encodeURIComponent(task.id)}`} className="home-task-link" data-testid={`home-up-next-task-${task.id}`}>
    <TaskDate value={task.deadline} />
    <div className="home-task-content"><strong className="break-words">{task.title}</strong><span className="home-task-description"><i style={{ background: projectColor(task.projectId) }} aria-hidden="true" />{task.projectName}<span aria-hidden="true"> · </span><span className={isTaskOverdue(task) ? 'task-overdue' : undefined}>{task.deadline ? `${isTaskOverdue(task) ? 'Overdue · ' : ''}${formatTaskDeadline(task.deadline)}` : 'No deadline'}</span><span aria-hidden="true"> · </span>{TASK_STATUS_LABELS[task.status]}</span></div>
    <span className={`home-task-importance importance-${task.importance}`}><span className={`importance-bars importance-bars-${task.importance}`} aria-hidden="true"><i /><i /><i /></span>{TASK_IMPORTANCE_LABELS[task.importance]}</span>
  </Link></li>;
}

function WorkspaceSection({
  workspaces,
  status,
  onRetry
}: {
  readonly workspaces: readonly HomeWorkspaceSummary[];
  readonly status: SummaryStatus;
  readonly onRetry: () => void;
}): React.JSX.Element {
  const hasWorkspaces = workspaces.length > 0;
  return <section className="home-projects" aria-labelledby="home-workspaces-heading" aria-busy={status === 'loading'} data-testid="home-workspaces-section">
    <header className="home-section-heading"><h2 id="home-workspaces-heading">Workspaces</h2></header>
    {status === 'loading' && !hasWorkspaces ? <div aria-busy="true" data-testid="home-workspaces-loading"><p className="sr-only" role="status">Loading workspaces</p><Skeleton className="project-card-skeleton" /></div> : null}
    {status === 'loading' && hasWorkspaces ? <p className="sr-only" role="status">Refreshing workspaces</p> : null}
    {status === 'error' && !hasWorkspaces ? <ErrorState title="Workspaces could not be loaded" detail="Try again to reload your workspace list." testId="home-workspaces-error" action={<Button type="button" variant="secondary" data-testid="home-workspaces-retry" onClick={onRetry}>Try again</Button>} /> : null}
    {status === 'error' && hasWorkspaces ? <Alert tone="error" data-testid="home-workspaces-error"><p>The workspace list could not be refreshed. Showing the last loaded workspace summaries.</p><Button type="button" variant="secondary" data-testid="home-workspaces-retry" onClick={onRetry}>Try again</Button></Alert> : null}
    {status === 'success' && !hasWorkspaces ? <p className="supporting-copy" data-testid="home-workspaces-empty">No workspaces yet.</p> : null}
    {hasWorkspaces ? <div className="project-grid" data-testid="home-workspace-list">{workspaces.map((workspace) => <WorkspaceCard key={workspace.project.id} workspace={workspace} />)}</div> : null}
  </section>;
}

function WorkspaceCard({ workspace }: { readonly workspace: HomeWorkspaceSummary }): React.JSX.Element {
  const { project, lastActivityAt } = workspace;
  const archived = project.status === 'archived';
  return <Card className={`project-item${archived ? '' : ' project-card-active'}`} data-testid="home-workspace-item">
    <Link className="project-item-link" to={`/projects/${encodeURIComponent(project.id)}`} data-testid={`home-workspace-link-${project.id}`}>
      <div className="project-card-top"><span className="project-tile" style={{ background: projectColor(project.id) }}><Icon name="folder" size={24} /></span><span className={`reference-pill${archived ? '' : ' reference-pill-active'}`}><i aria-hidden="true" />{archived ? 'Archived' : 'Active'}</span></div>
      <h3>{project.name}</h3>
      <p className="project-card-root">{project.capabilities.fileAccess ? 'Files available' : 'Planning only'}</p>
      {project.objective ? <p className="project-card-objective supporting-copy">{project.objective}</p> : null}
      <div className="project-card-bottom">{archived ? <span className="supporting-copy">Archived · read only</span> : lastActivityAt ? <WorkspaceActivity value={lastActivityAt} /> : <span className="supporting-copy">Activity unavailable</span>}<span className="project-open-arrow"><Icon name="arrow" /></span></div>
    </Link>
  </Card>;
}

function WorkspaceActivity({ value }: { readonly value: string }): React.JSX.Element {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="supporting-copy">Activity unavailable</span>;
  return <time className="supporting-copy" dateTime={value}>Last active {date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>;
}

function TaskDate({ value }: { readonly value: string | null }): React.JSX.Element {
  const parts = value?.split('-');
  const month = parts?.[1] ? Number(parts[1]) : 0;
  const day = parts?.[2] ? Number(parts[2]) : 0;
  const valid = parts?.length === 3 && Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(day) && day >= 1 && day <= 31;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return <span className="home-task-date" aria-hidden="true"><span>{valid ? months[month - 1] : 'No'}</span><strong>{valid ? day : '–'}</strong></span>;
}
