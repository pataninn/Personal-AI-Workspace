import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadProject, selectProjectDetail } from '@/entities/project';
import { ProjectContextSettings } from '@/features/project-context';
import { Alert, Button, ErrorState } from '@/shared/ui';

export function ProjectContextPage(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const dispatch = useAppDispatch();
  const detail = useAppSelector(selectProjectDetail(projectId));
  useEffect(() => { if (projectId) void dispatch(loadProject(projectId)); }, [projectId, dispatch]);
  if (detail.status === 'idle' || detail.status === 'loading') return <p role="status">Loading project…</p>;
  if (detail.status === 'error' || !detail.project) return <ErrorState title="Project context unavailable" detail="This project could not be loaded." action={<Button type="button" onClick={() => { void dispatch(loadProject(projectId)); }}>Try again</Button>} />;
  if (!detail.project.capabilities.fileAccess) return <Alert tone="error" data-testid="project-context-file-access-unavailable"><p>Project context is unavailable without file access.</p><Link className="button button-secondary" to={`/projects/${encodeURIComponent(projectId)}`}>Back to project</Link></Alert>;
  return (
    <div className="project-context-page content-start">
      <header className="project-memory-header"><div><h1>Context</h1><p className="supporting-copy">Choose the files and history your assistant can use.</p></div><Link className="button button-secondary" to={`/projects/${encodeURIComponent(projectId)}`}>Back to chat</Link></header>
      <ProjectContextSettings key={projectId} projectId={projectId} archived={detail.project.status === 'archived'} />
    </div>
  );
}
