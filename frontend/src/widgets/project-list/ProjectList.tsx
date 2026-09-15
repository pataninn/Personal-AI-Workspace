import { NavLink, useLocation } from 'react-router-dom';

import type { ProjectSnapshot } from '@/entities/project';
import { Button, Card } from '@/shared/ui';

interface ProjectListProps {
  readonly projects: readonly ProjectSnapshot[];
  readonly onCreate: () => void;
  readonly onArchive: (project: ProjectSnapshot) => void;
  readonly onRestore: (project: ProjectSnapshot) => void;
}

export function ProjectList({ projects, onCreate, onArchive, onRestore }: ProjectListProps): React.JSX.Element {
  const activeProjects = projects.filter((project) => project.status === 'active');
  const archivedProjects = projects.filter((project) => project.status === 'archived');
  return (
    <div className="project-list-sections" data-testid="project-list">
      <section aria-labelledby="active-projects-heading">
        <h2 id="active-projects-heading">Active projects</h2>
        {activeProjects.length === 0 ? (
          <section className="project-empty-state" data-testid="project-empty-state">
            <h3>No projects yet</h3>
            <p>Create a project to give the workspace a safe, named area for your work.</p>
            <Button type="button" data-testid="project-create-empty-trigger" onClick={onCreate}>Create your first project</Button>
          </section>
        ) : (
          <div className="project-grid">
            {activeProjects.map((project) => <ProjectListItem key={project.id} project={project} onArchive={onArchive} onRestore={onRestore} />)}
          </div>
        )}
      </section>
      {archivedProjects.length > 0 ? (
        <section aria-labelledby="archived-projects-heading">
          <h2 id="archived-projects-heading">Archived projects</h2>
          <p className="project-section-note">Archived projects preserve history but cannot be selected for new work until restored.</p>
          <div className="project-grid">
            {archivedProjects.map((project) => <ProjectListItem key={project.id} project={project} onArchive={onArchive} onRestore={onRestore} />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}

interface ProjectListItemProps {
  readonly project: ProjectSnapshot;
  readonly onArchive: (project: ProjectSnapshot) => void;
  readonly onRestore: (project: ProjectSnapshot) => void;
}

function ProjectListItem({ project, onArchive, onRestore }: ProjectListItemProps): React.JSX.Element {
  const isArchived = project.status === 'archived';
  const location = useLocation();
  const isSelected = location.pathname.startsWith(`/projects/${project.id}`);
  return (
    <Card className={`project-item${isSelected ? ' is-selected' : ''}`} data-testid="project-item">
      <NavLink
        className={({ isActive }) => `project-item-link${isActive ? ' is-selected' : ''}`}
        to={`/projects/${project.id}`}
        data-testid={isSelected ? 'project-selected' : undefined}
        aria-current={isSelected ? 'page' : undefined}
      >
        <span className="project-item-name">{project.name}</span>
        <span className="project-item-root">Project root: <code>{project.relativeRoot}</code></span>
        <span className={isArchived ? 'project-status project-status-archived' : 'project-status'} data-testid={isArchived ? 'project-archived-status' : 'project-active-status'}>{isArchived ? 'Archived' : 'Active'}</span>
      </NavLink>
      <div className="project-item-actions">
        {isArchived ? <Button type="button" variant="secondary" data-testid="project-restore-trigger" onClick={() => onRestore(project)}>Restore project</Button> : <Button type="button" variant="ghost" data-testid="project-archive-trigger" onClick={() => onArchive(project)}>Archive project</Button>}
      </div>
    </Card>
  );
}
