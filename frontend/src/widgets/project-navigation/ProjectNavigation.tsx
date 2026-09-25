import { NavLink, useLocation } from 'react-router-dom';

import { useAppSelector } from '@/app/store/hooks';
import { selectProjectErrorCode, selectProjectListStatus, selectProjects } from '@/entities/project';
import { Alert, Button, Skeleton } from '@/shared/ui';

interface ProjectNavigationProps {
  readonly onNavigate?: () => void;
}

export function ProjectNavigation({ onNavigate }: ProjectNavigationProps): React.JSX.Element {
  const location = useLocation();
  const status = useAppSelector(selectProjectListStatus);
  const projects = useAppSelector(selectProjects);
  const errorCode = useAppSelector(selectProjectErrorCode);
  const activeProjects = projects.filter((project) => project.status === 'active');
  const archivedProjects = projects.filter((project) => project.status === 'archived');
  const boundaryUnavailable = errorCode === 'WORKSPACE_BOUNDARY_UNAVAILABLE';
  const selectedProjectId = projectIdFromPath(location.pathname);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  return (
    <section className="project-navigation" data-testid="project-navigation" aria-labelledby="project-navigation-title">
      <h2 id="project-navigation-title">Projects</h2>
      {boundaryUnavailable ? (
        <span className="shell-nav-link project-create-link is-disabled" aria-disabled="true">New project unavailable</span>
      ) : (
        <NavLink className="shell-nav-link project-create-link" to="/dashboard?create=1" onClick={onNavigate}>New project</NavLink>
      )}
      {status === 'loading' || status === 'idle' ? (
        <div aria-busy="true" aria-label="Loading projects"><Skeleton className="project-nav-skeleton" /><Skeleton className="project-nav-skeleton" /></div>
      ) : null}
      {status === 'error' ? (
        <Alert tone="error" data-testid={boundaryUnavailable ? 'workspace-boundary-error' : 'project-list-error'}>
          {boundaryUnavailable ? 'The authoritative workspace is unavailable. Project actions are disabled.' : 'Projects could not be loaded. Try again to reload your projects.'}
        </Alert>
      ) : null}
      {status === 'success' ? (
        <>
          <nav aria-label="Active projects" className="project-nav-list">
            {activeProjects.map((project) => <NavLink key={project.id} to={`/projects/${project.id}`} onClick={onNavigate} className="project-nav-item">{project.name}</NavLink>)}
          </nav>
          {selectedProject ? <nav aria-label={`Selected project ${selectedProject.name}`} className="project-nav-memory"><NavLink data-testid={`project-memory-nav-${selectedProject.id}`} to={`/projects/${encodeURIComponent(selectedProject.id)}/memory`} onClick={onNavigate} className="project-nav-memory-item">Memory</NavLink></nav> : null}
          {archivedProjects.length > 0 ? <p className="project-nav-archived">Archived: {archivedProjects.length}</p> : null}
        </>
      ) : null}
      {boundaryUnavailable ? <Button type="button" variant="ghost" disabled>Workspace unavailable</Button> : null}
    </section>
  );
}

function projectIdFromPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)/u.exec(pathname);
  if (!match?.[1]) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
