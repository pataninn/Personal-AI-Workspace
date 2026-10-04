import { Link } from 'react-router-dom';
import type { ProjectSnapshot } from '@/entities/project';
import { Button, Card } from '@/shared/ui';

interface ProjectListProps {
  readonly projects: readonly ProjectSnapshot[];
  readonly onCreate: () => void;
  readonly onRemove: (project: ProjectSnapshot) => void;
}

/** Home projects are supplied in recent-activity order by the overview query. */
export function ProjectList({ projects, onCreate, onRemove }: ProjectListProps): React.JSX.Element {
  if (!projects.length) return <section className="project-empty-state" data-testid="project-empty-state"><h3>No projects yet</h3><p>Create a project to start chatting and planning.</p><Button type="button" data-testid="project-create-empty-trigger" onClick={onCreate}>Create your first project</Button></section>;
  return <div className="project-grid" data-testid="project-list">{projects.map((project) => <Card key={project.id} className="project-item" data-testid="project-item"><Link className="project-item-link" to={`/projects/${project.id}`}><h3>{project.name}</h3><p className="supporting-copy">{project.relativeRoot}</p></Link><Button type="button" variant="ghost" data-testid="project-remove-trigger" aria-label={`Remove ${project.name}`} onClick={() => { onRemove(project); }}>Remove</Button></Card>)}</div>;
}
