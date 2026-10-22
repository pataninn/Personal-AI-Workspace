import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadProject, selectProjectDetail } from '@/entities/project';
import { SkillsWorkspace } from '@/features/skills';
import { Alert, Button, ErrorState, Skeleton, Spinner } from '@/shared/ui';

export function SkillsPage(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const dispatch = useAppDispatch();
  const detail = useAppSelector(selectProjectDetail(projectId));
  useEffect(() => { if (projectId) void dispatch(loadProject(projectId)); }, [dispatch, projectId]);

  if (detail.status === 'idle' || detail.status === 'loading') return <section aria-busy="true" className="grid gap-4 p-6"><div className="loading-status"><Spinner label="Loading workspace" /><span role="status">Loading workspace…</span></div><Skeleton className="h-16" /></section>;
  if (detail.status === 'error' && detail.errorCode === 'WORKSPACE_BOUNDARY_UNAVAILABLE') return <Alert tone="error" role="alert"><p>This workspace is temporarily unavailable. Try again.</p><Button type="button" variant="secondary" onClick={() => { void dispatch(loadProject(projectId)); }}>Try again</Button></Alert>;
  if (detail.status === 'error' || !detail.project) return <ErrorState title="Workspace not found" detail="We could not load this workspace." action={<Link className="button button-secondary" to="/dashboard">Back to projects</Link>} />;
  return <SkillsWorkspace projectId={detail.project.id} projectName={detail.project.name} archived={detail.project.status === 'archived'} />;
}
