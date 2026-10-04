import { compareTaskPriority } from '@/entities/project-task';
import type { ProjectTask, ProjectTaskStatus } from '@/entities/project-task';
import { ProjectTaskItem } from '@/features/project-tasks/ui/ProjectTaskItem';

interface ProjectTaskListProps {
  readonly tasks: readonly ProjectTask[];
  readonly pendingKeys: readonly string[];
  readonly archivedProject: boolean;
  readonly actionErrors: Readonly<Record<string, string>>;
  readonly onEdit: (task: ProjectTask) => void;
  readonly onTransition: (task: ProjectTask, status: ProjectTaskStatus) => void;
  readonly onDelete: (task: ProjectTask) => void;
  readonly onToggleSubtask: (task: ProjectTask, subtaskId: string) => void;
  readonly targetTaskId?: string | null;
}

/** Present tasks by deadline and importance, without mutable manual ordering. */
export function ProjectTaskList({ tasks, pendingKeys, archivedProject, actionErrors, onEdit, onTransition, onDelete, onToggleSubtask, targetTaskId }: ProjectTaskListProps): React.JSX.Element {
  return <ol role="list" className="list-none space-y-2 p-0" data-testid="project-task-list" aria-label="Project tasks">{[...tasks].sort(compareTaskPriority).map((task) => (
    <ProjectTaskItem key={task.id} task={task} targeted={task.id === targetTaskId} pending={pendingKeys.includes(`task:${task.id}`)} archivedProject={archivedProject} actionError={actionErrors[task.id] ?? null} onEdit={onEdit} onTransition={onTransition} onDelete={onDelete} onToggleSubtask={onToggleSubtask} />
  ))}</ol>;
}
