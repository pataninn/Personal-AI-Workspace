import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAppSelector } from '@/app/store/hooks';
import { selectProjectErrorCode, selectProjectListStatus, selectProjects } from '@/entities/project';
import { ArchiveProjectDialog, CreateProjectDialog, useProjectListLoader } from '@/features/project-management';
import type { ProjectSnapshot } from '@/entities/project';
import { Alert, Button, Card, ErrorState, Skeleton, Spinner } from '@/shared/ui';
import { ProjectList } from '@/widgets/project-list';

export function DashboardPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { retry } = useProjectListLoader();
  const status = useAppSelector(selectProjectListStatus);
  const errorCode = useAppSelector(selectProjectErrorCode);
  const projects = useAppSelector(selectProjects);
  const [createOpen, setCreateOpen] = useState(false);
  const [action, setAction] = useState<{ project: ProjectSnapshot; mode: 'archive' | 'restore' } | null>(null);
  const boundaryUnavailable = errorCode === 'WORKSPACE_BOUNDARY_UNAVAILABLE';

  useEffect(() => {
    if (searchParams.get('create') === '1') {
      setCreateOpen(true);
      searchParams.delete('create');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  return (
    <div className="projects-page">
      <header className="projects-page-header">
        <div>
          <p className="product-label">Workspace</p>
          <h1>Projects</h1>
          <p className="supporting-copy">Choose a project to work in, or create one inside the configured local workspace.</p>
        </div>
        <Button type="button" data-testid="project-create-trigger" disabled={status !== 'success' || boundaryUnavailable} onClick={() => setCreateOpen(true)}>New project</Button>
      </header>
      <Alert tone="info" data-testid="workspace-boundary-status-message">
        <div className="workspace-boundary-note">
          <span className="workspace-boundary-mark" aria-hidden="true" />
          <div>
            <strong>Project boundaries stay local</strong>
            <p>The server checks each project before an operation. Roots stay inside your configured workspace, cannot overlap, and cannot change after creation.</p>
          </div>
        </div>
      </Alert>
      {status === 'loading' || status === 'idle' ? <ProjectListLoading /> : null}
      {status === 'error' ? (
        boundaryUnavailable ? (
          <Alert tone="error" data-testid="workspace-boundary-error" role="alert">
            <strong>The authoritative workspace is unavailable.</strong>
            <p>Project actions are disabled until the local workspace setup is safe again.</p>
            <Button type="button" variant="secondary" data-testid="workspace-boundary-retry-button" onClick={retry}>Try again</Button>
          </Alert>
        ) : (
          <ErrorState title="Projects could not be loaded" detail="Try again to reload your projects." testId="project-list-error" action={<Button type="button" variant="secondary" data-testid="project-retry-button" onClick={retry}>Try again</Button>} />
        )
      ) : null}
      {status === 'success' ? (
        <div aria-busy="false">
          <ProjectList projects={projects} onCreate={() => setCreateOpen(true)} onArchive={(project) => setAction({ project, mode: 'archive' })} onRestore={(project) => setAction({ project, mode: 'restore' })} />
        </div>
      ) : null}
      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onRetryBoundary={retry}
        onCreated={(projectId) => navigate(`/projects/${projectId}`)}
      />
      <ArchiveProjectDialog
        project={action?.project ?? null}
        mode={action?.mode}
        onOpenChange={(open) => { if (!open) setAction(null); }}
        onCompleted={() => setAction(null)}
        onRetryBoundary={retry}
      />
    </div>
  );
}

function ProjectListLoading(): React.JSX.Element {
  return (
    <section className="project-list-loading" data-testid="project-list-loading" aria-busy="true" aria-label="Loading projects">
      <div className="loading-status"><Spinner label="Loading projects" /><span role="status">Loading projects…</span></div>
      <Skeleton className="project-card-skeleton" />
      <Skeleton className="project-card-skeleton" />
    </section>
  );
}
