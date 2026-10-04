import type { ProjectTask, ProjectTaskImportance } from '@/entities/project-task/model/types';

export const TASK_IMPORTANCE_LABELS: Readonly<Record<ProjectTaskImportance, string>> = {
  low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent'
};

const IMPORTANCE_RANK: Readonly<Record<ProjectTaskImportance, number>> = {
  low: 0, medium: 1, high: 2, urgent: 3
};

/** Order dated work first, using importance to resolve an equal deadline. */
export function compareTaskPriority(left: ProjectTask, right: ProjectTask): number {
  const deadlineOrder = (left.deadline ?? '9999-12-31').localeCompare(right.deadline ?? '9999-12-31');
  return deadlineOrder || IMPORTANCE_RANK[right.importance] - IMPORTANCE_RANK[left.importance]
    || left.position - right.position || left.id.localeCompare(right.id);
}

/** Keep a date-only deadline in the local calendar without a UTC shift. */
export function formatTaskDeadline(deadline: string): string {
  const [year, month, day] = deadline.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(year, month - 1, day));
}

export function isTaskOverdue(task: Pick<ProjectTask, 'deadline' | 'status'>, today = new Date()): boolean {
  const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return task.status !== 'done' && task.deadline !== null && task.deadline < localDate;
}
