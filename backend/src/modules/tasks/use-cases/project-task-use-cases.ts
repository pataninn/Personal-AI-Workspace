import { createHash } from 'node:crypto';

import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { ProjectTaskArchivedProjectError, ProjectTaskIdempotencyKeyError, ProjectTaskStatusConflictError, ProjectTaskValidationError } from '@/modules/tasks/domain/project-task-errors';
import type { ProjectTaskFilter, ProjectTaskStatus } from '@/modules/tasks/domain/project-task';
import { canTransitionProjectTask, isProjectTaskStatus, normalizeTaskDetails, normalizeTaskTitle } from '@/modules/tasks/domain/project-task-validation';
import type { IProjectTaskRepository } from '@/modules/tasks/repositories/project-task-repository';

async function findProject(projectRepository: IProjectRepository, ownerId: string, projectId: string, writable: boolean): Promise<void> {
  const project = await projectRepository.findByIdForOwner(ownerId, projectId);
  if (!project) {
    throw new ProjectNotFoundError();
  }
  if (writable && project.status === 'archived') {
    throw new ProjectTaskArchivedProjectError();
  }
}

function validateIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(key)) {
    throw new ProjectTaskIdempotencyKeyError();
  }
  return key;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class ListProjectTasksUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly taskRepository: IProjectTaskRepository
  ) {}

  public async execute(input: { readonly ownerId: string; readonly projectId: string; readonly filter: ProjectTaskFilter }) {
    await findProject(this.projectRepository, input.ownerId, input.projectId, false);
    return this.taskRepository.listTasks(input.ownerId, input.projectId, input.filter);
  }
}

export class CreateProjectTaskUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly taskRepository: IProjectTaskRepository
  ) {}

  public async execute(input: { readonly ownerId: string; readonly projectId: string; readonly title: unknown; readonly details?: unknown; readonly idempotencyKey: string }) {
    await findProject(this.projectRepository, input.ownerId, input.projectId, true);
    const title = normalizeTaskTitle(input.title);
    const details = normalizeTaskDetails(input.details);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    return this.taskRepository.createTask({
      ownerId: input.ownerId,
      projectId: input.projectId,
      title,
      details,
      idempotencyKey,
      requestFingerprint: fingerprint({ title, details })
    });
  }
}

export class UpdateProjectTaskUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly taskRepository: IProjectTaskRepository
  ) {}

  public async execute(input: {
    readonly ownerId: string;
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly title?: unknown;
    readonly details?: unknown;
    readonly status?: unknown;
  }) {
    await findProject(this.projectRepository, input.ownerId, input.projectId, true);
    const hasText = input.title !== undefined || input.details !== undefined;
    if (input.status !== undefined && hasText) {
      throw new ProjectTaskStatusConflictError();
    }
    if (input.status !== undefined) {
      if (!isProjectTaskStatus(input.status)) {
        throw new ProjectTaskStatusConflictError();
      }
      return this.taskRepository.updateTask({
        ownerId: input.ownerId,
        projectId: input.projectId,
        taskId: input.taskId,
        expectedVersion: input.expectedVersion,
        status: input.status
      });
    }
    const text: { title?: string; details?: string | null } = {};
    if (input.title !== undefined) {
      text.title = normalizeTaskTitle(input.title);
    }
    if (input.details !== undefined) {
      text.details = normalizeTaskDetails(input.details);
    }
    if (Object.keys(text).length === 0) {
      throw new ProjectTaskStatusConflictError();
    }
    return this.taskRepository.updateTask({
      ownerId: input.ownerId,
      projectId: input.projectId,
      taskId: input.taskId,
      expectedVersion: input.expectedVersion,
      text
    });
  }
}

export class ReorderProjectTaskUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly taskRepository: IProjectTaskRepository
  ) {}

  public async execute(input: { readonly ownerId: string; readonly projectId: string; readonly taskId: string; readonly direction: 'up' | 'down'; readonly expectedOrderVersion: number }) {
    await findProject(this.projectRepository, input.ownerId, input.projectId, true);
    return this.taskRepository.reorderTask(input);
  }
}

export class ListProjectTaskSuggestionsUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly taskRepository: IProjectTaskRepository
  ) {}

  public async execute(input: { readonly ownerId: string; readonly projectId: string; readonly status: 'all' | 'pending'; readonly conversationId?: string }) {
    await findProject(this.projectRepository, input.ownerId, input.projectId, false);
    if (input.status === 'all' && !input.conversationId) {
      throw new ProjectTaskValidationError([{ field: 'conversationId', message: 'Choose a conversation to list resolved suggestions.' }]);
    }
    return this.taskRepository.listSuggestions(input.ownerId, input.projectId, { status: input.status, ...(input.conversationId ? { conversationId: input.conversationId } : {}) });
  }
}

export class ResolveProjectTaskSuggestionUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly taskRepository: IProjectTaskRepository
  ) {}

  public async execute(input: {
    readonly ownerId: string;
    readonly projectId: string;
    readonly suggestionId: string;
    readonly expectedVersion: number;
    readonly status: 'accepted' | 'dismissed';
    readonly title?: unknown;
    readonly details?: unknown;
  }) {
    await findProject(this.projectRepository, input.ownerId, input.projectId, true);
    if (input.status === 'dismissed') {
      return this.taskRepository.resolveSuggestion({
        ownerId: input.ownerId,
        projectId: input.projectId,
        suggestionId: input.suggestionId,
        expectedVersion: input.expectedVersion,
        decision: 'dismissed'
      });
    }
    const title = input.title === undefined ? undefined : normalizeTaskTitle(input.title);
    const details = input.details === undefined ? undefined : normalizeTaskDetails(input.details);
    return this.taskRepository.resolveSuggestion({
      ownerId: input.ownerId,
      projectId: input.projectId,
      suggestionId: input.suggestionId,
      expectedVersion: input.expectedVersion,
      decision: 'accepted',
      ...(title === undefined ? {} : { title }),
      ...(details === undefined ? {} : { details })
    });
  }
}

export function isAllowedProjectTaskTransition(current: ProjectTaskStatus, next: ProjectTaskStatus): boolean {
  return canTransitionProjectTask(current, next);
}
