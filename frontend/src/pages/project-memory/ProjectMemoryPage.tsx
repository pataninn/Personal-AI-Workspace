import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadProject, selectProjectDetail } from '@/entities/project';
import { ProjectMemoryManager } from '@/features/project-memory';
import { Alert, Button, ErrorState, Skeleton, Spinner } from '@/shared/ui';

/** Usage: Route for /projects/:projectId/memory; loads the project and renders its project-scoped fact manager. */
export function ProjectMemoryPage(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const dispatch = useAppDispatch();
  const detail = useAppSelector(selectProjectDetail(projectId));

  useEffect(() => {
    if (projectId) {
      void dispatch(loadProject(projectId));
    }
  }, [dispatch, projectId]);

  if (detail.status === 'idle' || detail.status === 'loading') {
    return <section className="project-memory-page" aria-busy="true"><div className="loading-status"><Spinner label="Loading project" /><span role="status">Loading project…</span></div><Skeleton className="project-heading-skeleton" /></section>;
  }
  if (detail.status === 'error' && detail.errorCode === 'WORKSPACE_BOUNDARY_UNAVAILABLE') {
    return <Alert tone="error" data-testid="workspace-boundary-error" role="alert"><p>The authoritative workspace is unavailable. This project cannot be loaded safely until the local workspace setup is available again.</p><Button type="button" variant="secondary" data-testid="project-memory-boundary-retry" onClick={() => { void dispatch(loadProject(projectId)); }}>Try again</Button></Alert>;
  }
  if (detail.status === 'error' && detail.errorCode === 'PROJECT_NOT_FOUND') {
    return <ErrorState title="Project not found" detail="We could not find that project in your workspace." testId="project-memory-project-error" action={<Link data-testid="project-memory-not-found-back" className="button button-secondary" to="/dashboard">Back to projects</Link>} />;
  }
  if (detail.status === 'error' || !detail.project) {
    return <ErrorState title="Project could not be loaded" detail="We could not load this project. Try again." testId="project-memory-project-error" action={<div className="error-state-actions"><Button type="button" variant="secondary" data-testid="project-memory-error-retry" onClick={() => { void dispatch(loadProject(projectId)); }}>Try again</Button><Link data-testid="project-memory-error-back" className="button button-secondary" to="/dashboard">Back to projects</Link></div>} />;
  }

  const project = detail.project;
  return (
    <div className="project-memory-page" data-testid="project-memory-page">
      <header className="project-memory-header">
        <div>
          <p className="product-label">{project.name}</p>
          <h1>Project memory</h1>
          <p className="supporting-copy">Review the facts saved for this project.</p>
        </div>
        <Link data-testid="project-memory-back-to-project" className="button button-secondary" to={`/projects/${encodeURIComponent(project.id)}`}>Back to project</Link>
      </header>
      <ProjectMemoryManager projectId={project.id} projectName={project.name} archived={project.status === 'archived'} fileAccess={project.capabilities.fileAccess} />
    </div>
  );
}
