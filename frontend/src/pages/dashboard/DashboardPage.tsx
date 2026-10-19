import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useAppSelector } from '@/app/store/hooks';
import { selectProjectState, useProjectOverview, type ProjectSnapshot } from '@/entities/project';
import { selectCsrfToken } from '@/entities/user-session';
import { CreateProjectDialog, useProjectListLoader } from '@/features/project-management';
import { Alert, Button, Icon } from '@/shared/ui';
import type { AppShellOutletContext } from '@/widgets/app-shell';
import { HomeOverviewWidget, type HomeWorkspaceSummary } from '@/widgets/home-overview';

/** Compose Home's primary work surfaces and independently refreshed task/workspace summaries. */
export function DashboardPage(): React.JSX.Element {
  const navigate = useNavigate();
  const shellContext = useOutletContext<AppShellOutletContext | null>();
  const [searchParams, setSearchParams] = useSearchParams();
  const home = useProjectOverview();
  const { retry } = useProjectListLoader();
  const projectState = useAppSelector(selectProjectState);
  const csrfToken = useAppSelector(selectCsrfToken);
  const [createOpen, setCreateOpen] = useState(false);
  const tasks = home.overview?.tasks ?? [];
  const boundaryUnavailable = home.errorCode === 'WORKSPACE_BOUNDARY_UNAVAILABLE';
  const workspaces = mergeHomeWorkspaces(projectState.projects, home.overview?.projects ?? []);
  const workspaceStatus = projectState.listStatus === 'idle' || projectState.listStatus === 'loading'
    ? 'loading'
    : projectState.listStatus;

  useEffect(() => {
    if (searchParams.get('create') === '1') { setCreateOpen(true); searchParams.delete('create'); setSearchParams(searchParams, { replace: true }); }
  }, [searchParams, setSearchParams]);

  const refreshWorkspaceData = useCallback((): void => { home.refresh(); retry(); }, [home.refresh, retry]);
  const registerHomeSummaryRefresh = shellContext?.registerHomeSummaryRefresh;

  useEffect(() => {
    registerHomeSummaryRefresh?.(refreshWorkspaceData);
    return () => registerHomeSummaryRefresh?.(null);
  }, [registerHomeSummaryRefresh, refreshWorkspaceData]);

  return <div className="projects-page home-page">
    <header className="projects-page-header home-hero"><div><p className="product-label">Home · {new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })}</p><h1 aria-label="Home">Pick up a <span>project</span> or<br className="hero-break" /> choose your <span>next task</span>.</h1></div><Button type="button" data-testid="project-create-trigger" disabled={home.status !== 'success' || boundaryUnavailable} onClick={() => { setCreateOpen(true); }}><Icon name="plus" size={18} />New project</Button></header>
    {boundaryUnavailable ? <Alert tone="error" data-testid="workspace-boundary-error" role="alert"><strong>The authoritative workspace is unavailable.</strong><p>Project actions are disabled until the local workspace setup is available.</p><Button type="button" variant="secondary" data-testid="workspace-boundary-retry-button" onClick={refreshWorkspaceData}>Try again</Button></Alert> : null}
    <HomeOverviewWidget
      tasks={tasks}
      taskStatus={home.status}
      onRetryTasks={home.refresh}
      workspaces={workspaces}
      workspaceStatus={workspaceStatus}
      onRetryWorkspaces={retry}
      csrfToken={csrfToken}
      onTaskCreated={refreshWorkspaceData}
    />
    <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(projectId) => { navigate(`/projects/${projectId}`); }} />
  </div>;
}

function mergeHomeWorkspaces(projects: readonly ProjectSnapshot[], overviewProjects: readonly (ProjectSnapshot & { readonly lastActivityAt: string })[]): HomeWorkspaceSummary[] {
  const knownActiveIds = new Set(overviewProjects.map((project) => project.id));
  const activeFromProjectList = projects.filter((project) => project.status === 'active' && !knownActiveIds.has(project.id));
  const archived = projects.filter((project) => project.status === 'archived');
  return [
    ...overviewProjects.map((project) => ({ project, lastActivityAt: project.lastActivityAt })),
    ...activeFromProjectList.map((project) => ({ project, lastActivityAt: null })),
    ...archived.map((project) => ({ project, lastActivityAt: null }))
  ];
}
