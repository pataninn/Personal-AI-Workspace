import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadProject, selectProjectDetail } from '@/entities/project';
import { ProjectActivityPanel } from '@/features/project-activity';
import { Alert, Button, ErrorState, Skeleton, Spinner } from '@/shared/ui';

export function ProjectActivityPage(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const dispatch = useAppDispatch();
  const detail = useAppSelector(selectProjectDetail(projectId));
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (projectId) void dispatch(loadProject(projectId));
  }, [dispatch, projectId]);

  useEffect(() => {
    if (detail.status === 'success' && detail.project) headingRef.current?.focus();
  }, [detail.project?.id, detail.status]);

  if (detail.status === 'idle' || detail.status === 'loading') {
    return <section className="project-activity-page" aria-busy="true"><div className="loading-status"><Spinner label="Loading project" /><span role="status">Loading project…</span></div><Skeleton className="project-heading-skeleton" /></section>;
  }
  if (detail.status === 'error' && detail.errorCode === 'WORKSPACE_BOUNDARY_UNAVAILABLE') {
    return <Alert tone="error" data-testid="workspace-boundary-error" role="alert"><p>The authoritative workspace is unavailable. This project cannot be loaded safely until local workspace setup is available again.</p><Button type="button" variant="secondary" onClick={() => { void dispatch(loadProject(projectId)); }}>Try again</Button></Alert>;
  }
  if (detail.status === 'error' && detail.errorCode === 'PROJECT_NOT_FOUND') {
    return <ErrorState title="Project not found" detail="We could not find that project in your workspace." testId="project-activity-project-error" action={<Link className="button button-secondary" to="/dashboard">Back to projects</Link>} />;
  }
  if (detail.status === 'error' || !detail.project) {
    return <ErrorState title="Project could not be loaded" detail="We could not load this project. Try again." testId="project-activity-project-error" action={<div className="error-state-actions"><Button type="button" variant="secondary" onClick={() => { void dispatch(loadProject(projectId)); }}>Try again</Button><Link className="button button-secondary" to="/dashboard">Back to projects</Link></div>} />;
  }

  const project = detail.project;
  if (project.relativeRoot === null) {
    return <Alert tone="error" data-testid="project-activity-root-required"><p>A project folder is required to use this area.</p><Link className="button button-secondary" to={`/projects/${encodeURIComponent(project.id)}`}>Back to planning workspace</Link></Alert>;
  }
  return (
    <div className="project-activity-page" data-testid="project-activity-page">
      <header className="project-activity-header">
        <div>
          <p className="product-label">{project.name}</p>
          <h1 ref={headingRef} tabIndex={-1} aria-label="Project activity">Activity</h1>
          <p className="supporting-copy">Review AI runs, selected context, file outcomes, and provider reported usage.</p>
        </div>
        <Link className="button button-secondary" to={`/projects/${encodeURIComponent(project.id)}`}>Back to project</Link>
      </header>
      <ProjectActivityPanel projectId={project.id} archived={project.status === 'archived'} />
    </div>
  );
}
