import { ProjectTaskDomainError } from '@/modules/tasks/domain/project-task-errors';

export class GlobalTaskNotFoundError extends ProjectTaskDomainError {
  public constructor() {
    super('TASK_NOT_FOUND', 404, 'The requested task was not found.');
  }
}

export class TaskQueryCursorInvalidError extends ProjectTaskDomainError {
  public constructor() {
    super('TASK_CURSOR_INVALID', 400, 'The task query cursor is invalid for these filters. Restart the query.');
  }
}
