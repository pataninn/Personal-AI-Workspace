import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useProjectOverview } from '@/entities/project';
import type { ProjectSnapshot } from '@/entities/project';
import { formatTaskDeadline, isTaskOverdue, TASK_IMPORTANCE_LABELS } from '@/entities/project-task';
import { CreateProjectDialog, RemoveProjectDialog, useProjectListLoader } from '@/features/project-management';
import { Alert, Button, Card, ErrorState, Skeleton } from '@/shared/ui';
import { ProjectList } from '@/widgets/project-list';

/** Home focuses on recent project activity and six upcoming tasks across projects. */
export function DashboardPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const home = useProjectOverview();
  const { retry } = useProjectListLoader();
  const [createOpen, setCreateOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProjectSnapshot | null>(null);
  const projects = home.overview?.projects ?? [];
  const tasks = home.overview?.tasks ?? [];
  const boundaryUnavailable = home.errorCode === 'WORKSPACE_BOUNDARY_UNAVAILABLE';

  useEffect(() => {
    if (searchParams.get('create') === '1') { setCreateOpen(true); searchParams.delete('create'); setSearchParams(searchParams, { replace: true }); }
  }, [searchParams, setSearchParams]);

  function refresh(): void { home.refresh(); retry(); }

  return <div className="projects-page home-page">
    <header className="projects-page-header"><div><p className="product-label">Workspace</p><h1>Home</h1><p className="supporting-copy">Pick up a project or choose your next task.</p></div><Button type="button" data-testid="project-create-trigger" disabled={home.status !== 'success' || boundaryUnavailable} onClick={() => { setCreateOpen(true); }}>New project</Button></header>
    {home.status === 'loading' ? <div aria-busy="true" data-testid="project-list-loading"><p role="status">Loading your workspace...</p><Skeleton className="project-card-skeleton" /></div> : null}
    {home.status === 'error' ? boundaryUnavailable ? <Alert tone="error" data-testid="workspace-boundary-error" role="alert"><strong>The authoritative workspace is unavailable.</strong><p>Project actions are disabled until the local workspace setup is available.</p><Button type="button" variant="secondary" data-testid="workspace-boundary-retry-button" onClick={refresh}>Try again</Button></Alert> : <ErrorState title="Workspace could not be loaded" detail="Try again to reload your projects and tasks." testId="project-list-error" action={<Button type="button" variant="secondary" data-testid="project-retry-button" onClick={refresh}>Try again</Button>} /> : null}
    {home.status === 'success' ? <>
      <section aria-labelledby="recent-projects-heading"><header className="home-section-heading"><h2 id="recent-projects-heading">Recent projects</h2><span className="supporting-copy">Recently active</span></header><ProjectList projects={projects.slice(0, 4)} onCreate={() => { setCreateOpen(true); }} onRemove={setRemoveTarget} /></section>
      {projects.length > 4 ? <details className="more-projects" data-testid="home-more-projects"><summary>Other projects ({projects.length - 4})</summary><ProjectList projects={projects.slice(4)} onCreate={() => { setCreateOpen(true); }} onRemove={setRemoveTarget} /></details> : null}
      <Card className="home-task-card"><header className="home-section-heading"><div><h2>Up next</h2><p className="supporting-copy">Nearest deadline, then importance. Across all projects.</p></div></header>
        {!tasks.length ? <p className="supporting-copy" data-testid="home-tasks-empty">No open tasks. Add one in a project to plan your next step.</p> : <ul className="home-task-list" data-testid="home-task-list">{tasks.map((task) => <li key={task.id}><Link to={`/projects/${task.projectId}/tasks?task=${encodeURIComponent(task.id)}`} className="home-task-link"><div><strong>{task.title}</strong><span className="supporting-copy">{task.projectName}</span></div><div className="home-task-meta"><span className={`importance-label importance-${task.importance}`}>{TASK_IMPORTANCE_LABELS[task.importance]}</span><span className={isTaskOverdue(task) ? 'task-overdue' : 'supporting-copy'}>{task.deadline ? `${isTaskOverdue(task) ? 'Overdue · ' : ''}${formatTaskDeadline(task.deadline)}` : 'No deadline'}</span></div></Link></li>)}</ul>}
      </Card>
    </> : null}
    <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} onRetryBoundary={refresh} onCreated={(projectId) => { navigate(`/projects/${projectId}`); }} />
    <RemoveProjectDialog project={removeTarget} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }} onRemoved={() => { setRemoveTarget(null); refresh(); }} />
  </div>;
}
