import { createHash } from 'node:crypto';

import { ProjectNotFoundError } from '@/modules/projects/domain/project-errors';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { ProjectTaskArchivedProjectError, ProjectTaskIdempotencyKeyError, ProjectTaskStatusConflictError, ProjectTaskValidationError } from '@/modules/tasks/domain/project-task-errors';
import type { ProjectTaskFilter, ProjectTaskStatus } from '@/modules/tasks/domain/project-task';
import { canTransitionProjectTask, isProjectTaskStatus, normalizeTaskDetails, normalizeTaskTitle } from '@/modules/tasks/domain/project-task-validation';
import type { IProjectTaskRepository } from '@/modules/tasks/repositories/project-task-repository';
import type { UpdateProjectTaskTextRecord } from '@/modules/tasks/repositories/project-task-repository';
import { normalizeTaskDeadline, normalizeTaskImportance, normalizeTaskSubtasks } from '@/modules/tasks/domain/task-planning-validation';
import type { ActionLedgerActorKind } from '@/modules/action-ledger/domain/action-ledger-types';
import type { ITaskMutationCommands } from '@/modules/tasks/use-cases/task-mutation-use-cases';
import { projectTaskOperationKey } from '@/modules/tasks/use-cases/task-mutation-use-cases';

interface TaskPlanningInput {
  readonly importance?: unknown;
  readonly deadline?: unknown;
  readonly subtasks?: unknown;
}

function normalizePlanning(input: TaskPlanningInput): UpdateProjectTaskTextRecord {
  return {
    ...(input.importance === undefined ? {} : { importance: normalizeTaskImportance(input.importance) }),
    ...(input.deadline === undefined ? {} : { deadline: normalizeTaskDeadline(input.deadline) }),
    ...(input.subtasks === undefined ? {} : { subtasks: normalizeTaskSubtasks(input.subtasks) })
  };
}

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

function planningFingerprint(input: TaskPlanningInput, normalized: UpdateProjectTaskTextRecord): Record<string, unknown> {
  const rawItems: readonly unknown[] = Array.isArray(input.subtasks) ? input.subtasks : [];
  return {
    importance: normalized.importance ?? 'medium', deadline: normalized.deadline ?? null,
    subtasks: (normalized.subtasks ?? []).map((item, index) => {
      const raw = rawItems[index];
      const id = raw && typeof raw === 'object' && 'id' in raw ? raw.id : null;
      return { ...item, id: id ?? null };
    })
  };
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
    private readonly taskRepository: IProjectTaskRepository,
    private readonly mutations?: ITaskMutationCommands
  ) {}

  public async execute(input: TaskPlanningInput & { readonly ownerId: string; readonly projectId: string; readonly title: unknown; readonly details?: unknown; readonly idempotencyKey: string; readonly actorKind?: ActionLedgerActorKind }) {
    if (!this.mutations) await findProject(this.projectRepository, input.ownerId, input.projectId, true);
    const title = normalizeTaskTitle(input.title);
    const details = normalizeTaskDetails(input.details);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const planning = normalizePlanning(input);
    if (this.mutations) {
      const result = await this.mutations.create({
        ownerId: input.ownerId,
        projectId: input.projectId,
        operationKey: projectTaskOperationKey('create', input.projectId, idempotencyKey),
        actorKind: input.actorKind ?? 'manual',
        title: input.title,
        ...(input.details === undefined ? {} : { details: input.details }),
        ...(input.importance === undefined ? {} : { importance: input.importance }),
        ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
        ...(input.subtasks === undefined ? {} : { subtasks: input.subtasks })
      });
      const snapshot = await this.taskRepository.listTasks(input.ownerId, input.projectId, 'all');
      return { task: result.item.task, orderVersion: snapshot.orderVersion, replayed: result.replayed };
    }
    const importance = planning.importance ?? 'medium';
    const deadline = planning.deadline ?? null;
    const subtasks = planning.subtasks ?? [];
    return this.taskRepository.createTask({
      ownerId: input.ownerId,
      projectId: input.projectId,
      title,
      details,
      importance,
      deadline,
      subtasks,
      idempotencyKey,
      requestFingerprint: fingerprint({ title, details, ...(Object.keys(planning).length ? planningFingerprint(input, planning) : {}) })
    });
  }
}

export class UpdateProjectTaskUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly taskRepository: IProjectTaskRepository,
    private readonly mutations?: ITaskMutationCommands
  ) {}

  public async execute(input: TaskPlanningInput & {
    readonly ownerId: string;
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly operationKey?: string;
    readonly actorKind?: ActionLedgerActorKind;
    readonly title?: unknown;
    readonly details?: unknown;
    readonly status?: unknown;
  }) {
    if (!this.mutations) await findProject(this.projectRepository, input.ownerId, input.projectId, true);
    const hasText = input.title !== undefined || input.details !== undefined || input.importance !== undefined || input.deadline !== undefined || input.subtasks !== undefined;
    if (input.status !== undefined && hasText) {
      throw new ProjectTaskStatusConflictError();
    }
    if (input.status !== undefined) {
      if (!isProjectTaskStatus(input.status) || input.status === 'archived') {
        throw new ProjectTaskStatusConflictError();
      }
      if (this.mutations) {
        const operationKey = input.operationKey === undefined ? undefined : projectTaskOperationKey('update', input.projectId, validateIdempotencyKey(input.operationKey));
        const result = await this.mutations.update({
          ownerId: input.ownerId,
          expectedProjectId: input.projectId,
          taskId: input.taskId,
          expectedVersion: input.expectedVersion,
          status: input.status,
          ...(operationKey === undefined ? {} : { operationKey }),
          actorKind: input.actorKind ?? 'manual'
        });
        const snapshot = await this.taskRepository.listTasks(input.ownerId, input.projectId, 'all');
        return { task: result.item.task, orderVersion: snapshot.orderVersion };
      }
      return this.taskRepository.updateTask({
        ownerId: input.ownerId,
        projectId: input.projectId,
        taskId: input.taskId,
        expectedVersion: input.expectedVersion,
        status: input.status
      });
    }
    const text: { -readonly [K in keyof UpdateProjectTaskTextRecord]: UpdateProjectTaskTextRecord[K] } = { ...normalizePlanning(input) };
    if (input.title !== undefined) {
      text.title = normalizeTaskTitle(input.title);
    }
    if (input.details !== undefined) {
      text.details = normalizeTaskDetails(input.details);
    }
    if (Object.keys(text).length === 0) {
      throw new ProjectTaskStatusConflictError();
    }
    if (this.mutations) {
      const operationKey = input.operationKey === undefined ? undefined : projectTaskOperationKey('update', input.projectId, validateIdempotencyKey(input.operationKey));
      const result = await this.mutations.update({
        ownerId: input.ownerId,
        expectedProjectId: input.projectId,
        taskId: input.taskId,
        expectedVersion: input.expectedVersion,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.details === undefined ? {} : { details: input.details }),
        ...(input.importance === undefined ? {} : { importance: input.importance }),
        ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
        ...(input.subtasks === undefined ? {} : { subtasks: input.subtasks }),
        ...(operationKey === undefined ? {} : { operationKey }),
        actorKind: input.actorKind ?? 'manual'
      });
      const snapshot = await this.taskRepository.listTasks(input.ownerId, input.projectId, 'all');
      return { task: result.item.task, orderVersion: snapshot.orderVersion };
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

/** Permanently removes an owned task with optimistic concurrency. */
export class DeleteProjectTaskUseCase {
  public constructor(
    private readonly projectRepository: IProjectRepository,
    private readonly taskRepository: IProjectTaskRepository,
    private readonly mutations?: ITaskMutationCommands
  ) {}

  public async execute(input: { readonly ownerId: string; readonly projectId: string; readonly taskId: string; readonly expectedVersion: number; readonly operationKey?: string; readonly actorKind?: ActionLedgerActorKind }): Promise<{ readonly orderVersion: number }> {
    if (this.mutations) {
      const operationKey = input.operationKey === undefined ? undefined : projectTaskOperationKey('archive', input.projectId, validateIdempotencyKey(input.operationKey));
      await this.mutations.archive({
        ownerId: input.ownerId,
        expectedProjectId: input.projectId,
        taskId: input.taskId,
        expectedVersion: input.expectedVersion,
        ...(operationKey === undefined ? {} : { operationKey }),
        actorKind: input.actorKind ?? 'manual'
      });
      const snapshot = await this.taskRepository.listTasks(input.ownerId, input.projectId, 'all');
      return { orderVersion: snapshot.orderVersion };
    }
    await findProject(this.projectRepository, input.ownerId, input.projectId, true);
    return this.taskRepository.deleteTask(input);
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

  public async execute(input: TaskPlanningInput & {
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
      ...normalizePlanning(input),
      ...(title === undefined ? {} : { title }),
      ...(details === undefined ? {} : { details })
    });
  }
}

export function isAllowedProjectTaskTransition(current: ProjectTaskStatus, next: ProjectTaskStatus): boolean {
  return canTransitionProjectTask(current, next);
}
