import type { ProjectTask, ProjectTaskFilter, ProjectTaskStatus } from '@/entities/project-task';
import { ProjectTaskItem } from '@/features/project-tasks/ui/ProjectTaskItem';

interface ProjectTaskListProps {
  readonly tasks: readonly ProjectTask[];
  readonly filter: ProjectTaskFilter;
  readonly pendingKeys: readonly string[];
  readonly archivedProject: boolean;
  readonly actionErrors: Readonly<Record<string, string>>;
  readonly onEdit: (task: ProjectTask) => void;
  readonly onTransition: (task: ProjectTask, status: ProjectTaskStatus) => void;
  readonly onMove: (task: ProjectTask, direction: 'up' | 'down') => void;
}

/** Usage: Render the authoritative server order as a semantic ordered list. */
export function ProjectTaskList({ tasks, filter, pendingKeys, archivedProject, actionErrors, onEdit, onTransition, onMove }: ProjectTaskListProps): React.JSX.Element {
  return (
    <ol className="project-task-list" data-testid="project-task-list" aria-label="Project tasks">
      {tasks.map((task, index) => (
        <ProjectTaskItem
          key={task.id}
          task={task}
          filter={filter}
          index={index}
          count={tasks.length}
          pending={pendingKeys.includes(`task:${task.id}`)}
          archivedProject={archivedProject}
          actionError={actionErrors[task.id] ?? null}
          onEdit={onEdit}
          onTransition={onTransition}
          onMove={onMove}
        />
      ))}
    </ol>
  );
}
