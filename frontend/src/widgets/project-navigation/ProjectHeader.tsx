import { Link, NavLink, useLocation, useParams } from 'react-router-dom';
import { useAppSelector } from '@/app/store/hooks';
import { projectColor, selectProjects } from '@/entities/project';
import type { ProjectSnapshot } from '@/entities/project';
import { Button, DropdownMenuContent, DropdownMenuItem, DropdownMenuRoot, DropdownMenuTrigger, Icon } from '@/shared/ui';

interface ProjectHeaderProps {
  readonly onRemove: (project: ProjectSnapshot) => void;
}

/** Keep existing project destinations in the reference's horizontal navigation. */
export function ProjectHeader({ onRemove }: ProjectHeaderProps): React.JSX.Element | null {
  const { projectId } = useParams();
  const { pathname } = useLocation();
  const project = useAppSelector(selectProjects).find((candidate) => candidate.id === projectId);
  if (!projectId || !project) return null;
  const hasFileAccess = project.relativeRoot !== null;
  const path = `/projects/${encodeURIComponent(projectId)}`;
  const workspaceActive = pathname === path || pathname.startsWith(`${path}/conversations`);
  const destinations = [
    ...(hasFileAccess ? [{ suffix: 'context', label: 'Context', testId: `project-context-nav-${projectId}` }] : []),
    { suffix: 'memory', label: 'Memory', testId: `project-memory-nav-${projectId}` },
    { suffix: 'tasks', label: 'Tasks', testId: `project-tasks-nav-${projectId}` },
    ...(hasFileAccess ? [
      { suffix: 'activity', label: 'Activity', testId: 'project-activity-link' },
      { suffix: 'file-history', label: 'History', testId: `project-file-history-nav-${projectId}` }
    ] : [])
  ];
  return <header className="reference-project-header">
    <div className="reference-project-identity"><span className="project-tile" style={{ background: projectColor(project.id) }}><Icon name="folder" size={26} /></span><div><div className="project-title-actions"><h2>{project.name}</h2><DropdownMenuRoot><DropdownMenuTrigger asChild><Button type="button" variant="ghost" className="project-actions-trigger" data-testid="project-actions-trigger" aria-label="Project actions"><span aria-hidden="true">⋯</span></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem className="project-remove-menu-item" data-testid="project-remove-trigger" onSelect={() => { onRemove(project); }}>Remove project</DropdownMenuItem></DropdownMenuContent></DropdownMenuRoot></div><p>{project.relativeRoot ?? 'Planning workspace'}</p></div></div>
    <nav aria-label="Project sections" className="reference-project-tabs">
      <Link data-testid={`project-workspace-nav-${projectId}`} to={path} className={workspaceActive ? 'is-active' : undefined} aria-current={workspaceActive ? 'page' : undefined}>Workspace</Link>
      {destinations.map((destination) => <NavLink key={destination.suffix} data-testid={destination.testId} to={`${path}/${destination.suffix}`} className={({ isActive }) => isActive ? 'is-active' : undefined} aria-label={destination.suffix === 'file-history' ? 'File history' : undefined}>{destination.label}</NavLink>)}
    </nav>
  </header>;
}
