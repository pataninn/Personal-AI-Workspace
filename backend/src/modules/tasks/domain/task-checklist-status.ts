import type { ProjectTaskStatus, ProjectTaskSubtask } from '@/modules/tasks/domain/project-task';

interface TaskChecklistState {
  readonly status: ProjectTaskStatus;
  readonly subtasks: readonly ProjectTaskSubtask[];
}

/** Empty checklists never complete a parent task automatically. */
export function isTaskChecklistComplete(subtasks: readonly ProjectTaskSubtask[]): boolean {
  return subtasks.length > 0 && subtasks.every((item) => item.completed);
}

/** Applies the confirmed parent/checklist completion policy in one write. */
export function resolveTaskChecklistState(input: {
  readonly current: TaskChecklistState;
  readonly status?: ProjectTaskStatus;
  readonly subtasks?: readonly ProjectTaskSubtask[];
}): TaskChecklistState {
  const subtasks = input.subtasks ?? input.current.subtasks;
  if (input.status === 'done') {
    return { status: 'done', subtasks: subtasks.map((item) => ({ ...item, completed: true })) };
  }
  if (input.subtasks !== undefined && isTaskChecklistComplete(subtasks)) {
    return { status: 'done', subtasks };
  }
  const reopened = input.subtasks !== undefined && input.current.status === 'done' && subtasks.some((item) => !item.completed);
  return { status: reopened ? 'todo' : input.status ?? input.current.status, subtasks };
}
