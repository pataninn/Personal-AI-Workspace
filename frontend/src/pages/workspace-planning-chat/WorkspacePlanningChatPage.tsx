import { useEffect } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';

import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadProject, selectProjectDetail } from '@/entities/project';
import { HomeChatWidget } from '@/widgets/home-chat';
import { Alert, Button, ErrorState, Skeleton, Spinner } from '@/shared/ui';

const ARCHIVED_WORKSPACE_REASON = 'This planning workspace is archived. Its conversation history is read-only.';

export function WorkspacePlanningChatPage(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const dispatch = useAppDispatch();
  const detail = useAppSelector(selectProjectDetail(projectId));

  useEffect(() => {
    if (projectId) void dispatch(loadProject(projectId));
  }, [dispatch, projectId]);

  if (detail.status === 'idle' || detail.status === 'loading') return <PlanningChatLoading />;
  if (detail.status === 'error') return <ProjectLoadError code={detail.errorCode} onRetry={() => { void dispatch(loadProject(projectId)); }} />;
  if (!detail.project) return <ErrorState title="Planning chat could not be loaded" detail="Try again to reload this workspace." />;
  if (detail.project.capabilities.fileAccess) return <Navigate to={`/projects/${encodeURIComponent(detail.project.id)}`} replace />;

  const archived = detail.project.status === 'archived';
  return <HomeChatWidget scope={{ kind: 'workspace', workspaceId: detail.project.id }} scopeLabel={detail.project.name} disabled={archived} disabledReason={archived ? ARCHIVED_WORKSPACE_REASON : undefined} />;
}

function PlanningChatLoading(): React.JSX.Element {
  return <section className="project-detail-loading" aria-busy="true" aria-label="Loading planning chat"><div className="loading-status"><Spinner label="Loading workspace" /><span role="status">Loading planning workspace…</span></div><Skeleton className="project-heading-skeleton" /></section>;
}

interface ProjectLoadErrorProps {
  readonly code: string | null;
  readonly onRetry: () => void;
}

function ProjectLoadError({ code, onRetry }: ProjectLoadErrorProps): React.JSX.Element {
  if (code === 'WORKSPACE_BOUNDARY_UNAVAILABLE') {
    return (
      <Alert tone="error" data-testid="workspace-boundary-error" role="alert">
        <p>The authoritative workspace is unavailable. Planning chat cannot load safely until local workspace setup is available again.</p>
        <Button type="button" variant="secondary" data-testid="planning-chat-boundary-retry" onClick={onRetry}>Try again</Button>
      </Alert>
    );
  }

  const missing = code === 'PROJECT_NOT_FOUND';
  const backLink = <Link className="button button-secondary" data-testid="planning-chat-error-back" to="/dashboard">Back to projects</Link>;
  return (
    <ErrorState
      title={missing ? 'Planning workspace not found' : 'Planning chat could not be loaded'}
      detail={missing ? 'We could not find that workspace.' : 'Try again to reload this workspace.'}
      testId="planning-chat-project-error"
      action={missing ? backLink : <div className="error-state-actions"><Button type="button" variant="secondary" data-testid="planning-chat-error-retry" onClick={onRetry}>Try again</Button>{backLink}</div>}
    />
  );
}
