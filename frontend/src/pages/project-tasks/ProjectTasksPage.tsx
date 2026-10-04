import { useEffect, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadProject, selectProjectDetail } from '@/entities/project';
import { ProjectTasksManager } from '@/features/project-tasks';
import { Alert, Button, ErrorState, Skeleton, Spinner } from '@/shared/ui';

/** Usage: Route for /projects/:projectId/tasks; loads the selected project before showing its task manager. */
export function ProjectTasksPage(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const targetTaskId = searchParams.get('task');
  const dispatch = useAppDispatch();
  const detail = useAppSelector(selectProjectDetail(projectId));
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (projectId) {
      void dispatch(loadProject(projectId));
    }
  }, [dispatch, projectId]);

  useEffect(() => {
    if (detail.status === 'success' && detail.project) {
      headingRef.current?.focus();
    }
  }, [detail.project?.id, detail.status]);

  if (detail.status === 'idle' || detail.status === 'loading') {
    return <section className="project-tasks-page" aria-busy="true"><div className="loading-status"><Spinner label="Loading project" /><span role="status">Loading project…</span></div><Skeleton className="project-heading-skeleton" /></section>;
  }
  if (detail.status === 'error' && detail.errorCode === 'WORKSPACE_BOUNDARY_UNAVAILABLE') {
    return <Alert tone="error" data-testid="workspace-boundary-error" role="alert"><p>The authoritative workspace is unavailable. This project cannot be loaded safely until the local workspace setup is available again.</p><Button type="button" variant="secondary" data-testid="project-tasks-boundary-retry" onClick={() => { void dispatch(loadProject(projectId)); }}>Try again</Button></Alert>;
  }
  if (detail.status === 'error' && detail.errorCode === 'PROJECT_NOT_FOUND') {
    return <ErrorState title="Project not found" detail="We could not find that project in your workspace." testId="project-tasks-project-error" action={<Link data-testid="project-tasks-not-found-back" className="button button-secondary" to="/dashboard">Back to projects</Link>} />;
  }
  if (detail.status === 'error' || !detail.project) {
    return <ErrorState title="Project could not be loaded" detail="We could not load this project. Try again." testId="project-tasks-project-error" action={<div className="error-state-actions"><Button type="button" variant="secondary" data-testid="project-tasks-error-retry" onClick={() => { void dispatch(loadProject(projectId)); }}>Try again</Button><Link data-testid="project-tasks-error-back" className="button button-secondary" to="/dashboard">Back to projects</Link></div>} />;
  }

  const project = detail.project;
  return (
    <div className="project-tasks-page" data-testid="project-tasks-page">
      <header className="project-tasks-header">
        <div>
          <p className="product-label">{project.name}</p>
          <h1 ref={headingRef} tabIndex={-1}>Project tasks</h1>
          <p className="supporting-copy">Track work for this project. Tasks do not run automatically.</p>
        </div>
        <Link data-testid="project-tasks-back-to-project" className="button button-secondary" to={`/projects/${encodeURIComponent(project.id)}`}>Back to project</Link>
      </header>
      <ProjectTasksManager key={project.id} projectId={project.id} projectName={project.name} targetTaskId={targetTaskId} archived={project.status === 'archived'} />
    </div>
  );
}
