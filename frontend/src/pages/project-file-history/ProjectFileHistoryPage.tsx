import { useEffect, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { loadProject, selectProjectDetail } from '@/entities/project';
import type { ProjectFileHistoryOutcome } from '@/entities/ai-run';
import { ProjectFileHistoryPanel } from '@/features/project-file-history';
import { Alert, Button, ErrorState, Skeleton, Spinner } from '@/shared/ui';

export function ProjectFileHistoryPage(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const path = searchParams.get('path') ?? '';
  const outcome: ProjectFileHistoryOutcome = searchParams.get('outcome') === 'applied' ? 'applied' : 'all';
  const dispatch = useAppDispatch();
  const detail = useAppSelector(selectProjectDetail(projectId));
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { if (projectId) void dispatch(loadProject(projectId)); }, [dispatch, projectId]);
  useEffect(() => { if (detail.status === 'success' && detail.project) headingRef.current?.focus(); }, [detail.project?.id, detail.status]);

  if (detail.status === 'idle' || detail.status === 'loading') return <section className="project-file-history-page" aria-busy="true"><div className="loading-status"><Spinner label="Loading project" /><span role="status">Loading project…</span></div><Skeleton className="project-heading-skeleton" /></section>;
  if (detail.status === 'error' && detail.errorCode === 'WORKSPACE_BOUNDARY_UNAVAILABLE') return <Alert tone="error" role="alert"><p>The authoritative workspace is unavailable. This project cannot be loaded safely until local workspace setup is available again.</p><Button type="button" variant="secondary" onClick={() => { void dispatch(loadProject(projectId)); }}>Try again</Button></Alert>;
  if (detail.status === 'error' && detail.errorCode === 'PROJECT_NOT_FOUND') return <ErrorState title="Project not found" detail="We could not find that project in your workspace." testId="file-history-project-error" action={<Link className="button button-secondary" to="/dashboard">Back to projects</Link>} />;
  if (detail.status === 'error' || !detail.project) return <ErrorState title="Project could not be loaded" detail="We could not load this project. Try again." testId="file-history-project-error" action={<div className="error-state-actions"><Button type="button" variant="secondary" onClick={() => { void dispatch(loadProject(projectId)); }}>Try again</Button><Link className="button button-secondary" to="/dashboard">Back to projects</Link></div>} />;

  const project = detail.project;
  const setOutcome = (value: ProjectFileHistoryOutcome): void => {
    const next = new URLSearchParams(searchParams);
    next.set('outcome', value);
    setSearchParams(next);
  };
  return <div className="project-file-history-page" data-testid="project-file-history-page">
    <header className="project-activity-header"><div><p className="product-label">{project.name}</p><h1 ref={headingRef} tabIndex={-1}>File history</h1><p className="supporting-copy">Review proposals and operation outcomes recorded for one project path.</p></div><Link className="button button-secondary" to={`/projects/${encodeURIComponent(project.id)}/activity`}>Back to activity</Link></header>
    {!path ? <Alert tone="info" data-testid="file-history-no-path">Open file history from a file operation or proposed change to choose a project path.</Alert> : <ProjectFileHistoryPanel projectId={project.id} path={path} outcome={outcome} archived={project.status === 'archived'} onOutcomeChange={setOutcome} />}
  </div>;
}
