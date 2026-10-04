import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadProject, selectProjectDetail } from '@/entities/project';
import { Alert, Button, ErrorState, Skeleton, Spinner } from '@/shared/ui';
import { ProjectWorkspaceLayout } from '@/widgets/project-workspace';
import { ProjectFilesPanel, useProjectFiles } from '@/features/project-files';

export function ProjectWorkspacePage(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const dispatch = useAppDispatch();
  const files = useProjectFiles(projectId);
  const detail = useAppSelector(selectProjectDetail(projectId));

  useEffect(() => {
    if (projectId) {
      void dispatch(loadProject(projectId));
    }
  }, [dispatch, projectId]);

  function retryProjectLoad(): void {
    if (projectId) {
      void dispatch(loadProject(projectId));
    }
  }

  if (detail.status === 'idle' || detail.status === 'loading') {
    return <ProjectDetailLoading />;
  }
  if (detail.status === 'error' && detail.errorCode === 'WORKSPACE_BOUNDARY_UNAVAILABLE') {
    return (
      <Alert tone="error" data-testid="workspace-boundary-error" role="alert">
        <strong>The authoritative workspace is unavailable.</strong>
        <p>This project cannot be loaded safely until the local workspace setup is available again.</p>
        <Button type="button" variant="secondary" data-testid="workspace-boundary-retry-button" onClick={retryProjectLoad}>Try again</Button>
      </Alert>
    );
  }
  if (detail.status === 'error' && detail.errorCode === 'PROJECT_NOT_FOUND') {
    return <ErrorState title="Project not found" detail="We could not find that project in your workspace." testId="project-not-found-state" action={<Link className="button button-secondary" data-testid="project-back-to-list" to="/dashboard">Back to projects</Link>} />;
  }
  if (detail.status === 'error' || !detail.project) {
    return <ErrorState title="Project could not be loaded" detail="We could not load this project. Try again." testId="project-detail-error" action={<div className="error-state-actions"><Button type="button" variant="secondary" data-testid="project-detail-retry-button" onClick={retryProjectLoad}>Try again</Button><Link className="button button-secondary" data-testid="project-back-to-list" to="/dashboard">Back to projects</Link></div>} />;
  }
  const project = detail.project;
  const isArchived = project.status === 'archived';
  return (
    <div className="project-workspace-view" data-testid="project-workspace-view">
      <header className="project-detail-header">
        <div>
          <p className="product-label">Project</p>
          <h1>{project.name}</h1>
          <p className="project-status" data-testid={isArchived ? 'project-archived-status' : 'project-active-status'}>{isArchived ? 'Archived' : 'Active'}</p>
        </div>
      </header>
      <ProjectWorkspaceLayout project={project} filePanel={<ProjectFilesPanel projectId={projectId} paths={files.paths} loading={files.loading} error={files.error} limited={files.limited} onRefresh={files.refresh} />} />
    </div>
  );
}

function ProjectDetailLoading(): React.JSX.Element {
  return (
    <section className="project-detail-loading" data-testid="project-workspace-view" aria-busy="true" aria-label="Loading project">
      <div className="loading-status"><Spinner label="Loading project" /><span role="status">Loading project…</span></div>
      <Skeleton className="project-heading-skeleton" />
      <Skeleton className="project-boundary-skeleton" />
    </section>
  );
}
