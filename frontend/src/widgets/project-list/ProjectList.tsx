import { Link } from 'react-router-dom';
import type { ProjectSnapshot } from '@/entities/project';
import { projectColor } from '@/entities/project';
import { Button, Card, Icon } from '@/shared/ui';

interface ProjectListProps {
  readonly projects: readonly ProjectSnapshot[];
  readonly onCreate: () => void;
}

/** Home projects are supplied in recent-activity order by the overview query. */
export function ProjectList({ projects, onCreate }: ProjectListProps): React.JSX.Element {
  if (!projects.length) return <section className="project-empty-state" data-testid="project-empty-state"><h3>No projects yet</h3><p>Create a project to start chatting and planning.</p><Button type="button" data-testid="project-create-empty-trigger" onClick={onCreate}>Create your first project</Button></section>;
  return <div className="project-grid" data-testid="project-list">{projects.map((project) => <Card key={project.id} className={`project-item${project.status === 'active' ? ' project-card-active' : ''}`} data-testid="project-item">
    <Link className="project-item-link" to={`/projects/${project.id}`}>
      <div className="project-card-top"><span className="project-tile" style={{ background: projectColor(project.id) }}><Icon name="folder" size={24} /></span><span className={`reference-pill${project.status === 'active' ? ' reference-pill-active' : ''}`}><i aria-hidden="true" />{project.status === 'active' ? 'Active' : 'Archived'}</span></div>
      <h3>{project.name}</h3><p className="project-card-root">{project.capabilities.fileAccess ? 'Files available' : 'Planning only'}</p>{!project.capabilities.fileAccess && project.objective ? <p className="project-card-objective">{project.objective}</p> : null}
      <div className="project-card-bottom"><time dateTime={project.updatedAt}>Updated {new Date(project.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time><span className="project-open-arrow"><Icon name="arrow" /></span></div>
    </Link>
  </Card>)}</div>;
}
