import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { projectColor, useProjectOverview } from '@/entities/project';
import { formatTaskDeadline, isTaskOverdue, TASK_IMPORTANCE_LABELS } from '@/entities/project-task';
import { CreateProjectDialog, useProjectListLoader } from '@/features/project-management';
import { Alert, Button, Card, ErrorState, Icon, Skeleton } from '@/shared/ui';
import { ProjectList } from '@/widgets/project-list';

/** Home focuses on recent project activity and six upcoming tasks across projects. */
export function DashboardPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const home = useProjectOverview();
  const { retry } = useProjectListLoader();
  const [createOpen, setCreateOpen] = useState(false);
  const projects = home.overview?.projects ?? [];
  const tasks = home.overview?.tasks ?? [];
  const boundaryUnavailable = home.errorCode === 'WORKSPACE_BOUNDARY_UNAVAILABLE';

  useEffect(() => {
    if (searchParams.get('create') === '1') { setCreateOpen(true); searchParams.delete('create'); setSearchParams(searchParams, { replace: true }); }
  }, [searchParams, setSearchParams]);

  function refresh(): void { home.refresh(); retry(); }

  return <div className="projects-page home-page">
    <header className="projects-page-header home-hero"><div><p className="product-label">Home · {new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })}</p><h1 aria-label="Home">Pick up a <span>project</span> or<br className="hero-break" /> choose your <span>next task</span>.</h1></div><Button type="button" data-testid="project-create-trigger" disabled={home.status !== 'success' || boundaryUnavailable} onClick={() => { setCreateOpen(true); }}><Icon name="plus" size={18} />New project</Button></header>
    {home.status === 'loading' ? <div aria-busy="true" data-testid="project-list-loading"><p role="status">Loading your workspace...</p><Skeleton className="project-card-skeleton" /></div> : null}
    {home.status === 'error' ? boundaryUnavailable ? <Alert tone="error" data-testid="workspace-boundary-error" role="alert"><strong>The authoritative workspace is unavailable.</strong><p>Project actions are disabled until the local workspace setup is available.</p><Button type="button" variant="secondary" data-testid="workspace-boundary-retry-button" onClick={refresh}>Try again</Button></Alert> : <ErrorState title="Workspace could not be loaded" detail="Try again to reload your projects and tasks." testId="project-list-error" action={<Button type="button" variant="secondary" data-testid="project-retry-button" onClick={refresh}>Try again</Button>} /> : null}
    {home.status === 'success' ? <div className="home-overview-grid">
      <section className="home-projects" aria-labelledby="recent-projects-heading"><header className="home-section-heading"><h2 id="recent-projects-heading">Recent projects</h2><span className="reference-count">{String(projects.length).padStart(2, '0')}</span></header><ProjectList projects={projects.slice(0, 4)} onCreate={() => { setCreateOpen(true); }} />
      {projects.length > 4 ? <details className="more-projects" data-testid="home-more-projects"><summary>Other projects ({projects.length - 4})</summary><ProjectList projects={projects.slice(4)} onCreate={() => { setCreateOpen(true); }} /></details> : null}
      </section>
      <Card className="home-task-card"><header className="home-section-heading"><h2>Up next</h2><span className="reference-count">{String(tasks.length).padStart(2, '0')}</span></header>
        {!tasks.length ? <p className="supporting-copy home-tasks-empty" data-testid="home-tasks-empty">No open tasks. Add one in a project to plan your next step.</p> : <ul className="home-task-list" data-testid="home-task-list">{tasks.map((task) => <li key={task.id}><Link to={`/projects/${task.projectId}/tasks?task=${encodeURIComponent(task.id)}`} className="home-task-link"><TaskDate value={task.deadline} /><div className="home-task-content"><strong>{task.title}</strong><span className="home-task-description"><i style={{ background: projectColor(task.projectId) }} aria-hidden="true" />{task.projectName}<span aria-hidden="true"> · </span><span className={isTaskOverdue(task) ? 'task-overdue' : undefined}>{task.deadline ? `${isTaskOverdue(task) ? 'Overdue · ' : ''}${formatTaskDeadline(task.deadline)}` : 'No deadline'}</span></span></div><span className={`home-task-importance importance-${task.importance}`}><span className={`importance-bars importance-bars-${task.importance}`} aria-hidden="true"><i /><i /><i /></span>{TASK_IMPORTANCE_LABELS[task.importance]}</span></Link></li>)}</ul>}
      </Card>
    </div> : null}
    <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} onRetryBoundary={refresh} onCreated={(projectId) => { navigate(`/projects/${projectId}`); }} />
  </div>;
}

function TaskDate({ value }: { readonly value: string | null }): React.JSX.Element {
  const date = value ? new Date(value) : null;
  const valid = date && !Number.isNaN(date.getTime());
  return <span className="home-task-date" aria-hidden="true"><span>{valid ? date.toLocaleDateString('en', { month: 'short' }) : 'No'}</span><strong>{valid ? date.getDate() : '–'}</strong></span>;
}
