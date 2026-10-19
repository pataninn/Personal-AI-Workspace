import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { ProjectTaskNotFoundError, ProjectTaskVersionRequiredError } from '@/modules/tasks/domain/project-task-errors';
import type { ProjectTask, ProjectTaskSuggestion } from '@/modules/tasks/domain/project-task';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';
import {
  CreateProjectTaskUseCase,
  ListProjectTaskSuggestionsUseCase,
  ListProjectTasksUseCase,
  ReorderProjectTaskUseCase,
  ResolveProjectTaskSuggestionUseCase,
  UpdateProjectTaskUseCase
} from '@/modules/tasks/use-cases/project-task-use-cases';

const planningFields = {
  importance: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  deadline: z.string().nullable().optional(),
  subtasks: z.array(z.object({ id: z.string().uuid().optional(), title: z.string(), completed: z.boolean().optional() }).strict()).max(50).optional()
};
const createTaskSchema = z.object({ title: z.string(), details: z.string().nullable().optional(), ...planningFields }).strict();
const updateTextSchema = z.object({ title: z.string().optional(), details: z.string().nullable().optional(), ...planningFields }).strict().refine((value) => Object.keys(value).length > 0);
const updateStatusSchema = z.object({ status: z.enum(['todo', 'in_progress', 'blocked', 'done']) }).strict();
const updateTaskSchema = z.union([updateTextSchema, updateStatusSchema]);
const reorderTaskSchema = z.object({ taskId: z.string(), direction: z.enum(['up', 'down']) }).strict();
const acceptSuggestionSchema = z.object({ status: z.literal('accepted'), title: z.string().optional(), details: z.string().nullable().optional(), ...planningFields }).strict();
const dismissSuggestionSchema = z.object({ status: z.literal('dismissed') }).strict();
const resolveSuggestionSchema = z.union([acceptSuggestionSchema, dismissSuggestionSchema]);
const taskFilterSchema = z.enum(['all', 'open', 'completed']);
const suggestionFilterSchema = z.enum(['all', 'pending']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ProjectTaskRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly listTasks: ListProjectTasksUseCase;
  readonly createTask: CreateProjectTaskUseCase;
  readonly updateTask: UpdateProjectTaskUseCase;
  readonly reorderTask: ReorderProjectTaskUseCase;
  readonly listSuggestions: ListProjectTaskSuggestionsUseCase;
  readonly resolveSuggestion: ResolveProjectTaskSuggestionUseCase;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function parseId(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ProjectTaskNotFoundError();
  }
  return value;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The project task request is invalid.', result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request',
      message: issue.message
    })));
  }
  return result.data;
}

function parseIfMatch(value: string | undefined): number {
  const match = value?.match(/^"([1-9]\d*)"$/u);
  const version = match?.[1] ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ProjectTaskVersionRequiredError();
  }
  return version;
}

function parseFilter(value: unknown): 'all' | 'open' | 'completed' {
  const parsed = taskFilterSchema.safeParse(value ?? 'all');
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The project task filter is invalid.', [{ field: 'status', message: 'Use all, open, or completed.' }]);
  }
  return parsed.data;
}

function parseSuggestionFilter(value: unknown): 'all' | 'pending' {
  const parsed = suggestionFilterSchema.safeParse(value ?? 'pending');
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The task suggestion filter is invalid.', [{ field: 'status', message: 'Use all or pending.' }]);
  }
  return parsed.data;
}

function parseConversationQuery(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppError('VALIDATION_ERROR', 400, 'The task suggestion conversation filter is invalid.', [{ field: 'conversationId', message: 'Use a conversation identifier.' }]);
  }
  return value;
}

function serializeTask(task: ProjectTask): Record<string, unknown> {
  return {
    ...task,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
    source: { ...task.source, acceptedAt: task.source.acceptedAt?.toISOString() ?? null }
  };
}

function serializeSuggestion(suggestion: ProjectTaskSuggestion): Record<string, unknown> {
  return {
    ...suggestion,
    createdAt: suggestion.createdAt.toISOString(),
    resolvedAt: suggestion.resolvedAt?.toISOString() ?? null
  };
}

function ownerId(request: Parameters<RequestHandler>[0]): string {
  const id = request.auth?.principal.id;
  if (!id) {
    throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
  }
  return id;
}

function listTasksHandler(dependencies: ProjectTaskRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const projectId = parseId(routeParam(request.params.projectId));
      const snapshot = await dependencies.listTasks.execute({ ownerId: ownerId(request), projectId, filter: parseFilter(request.query.status) });
      response.setHeader('ETag', `"${snapshot.orderVersion}"`);
      sendData(response, { tasks: snapshot.tasks.map(serializeTask), orderVersion: snapshot.orderVersion });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function createTaskHandler(dependencies: ProjectTaskRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const projectId = parseId(routeParam(request.params.projectId));
      const body = parseBody(createTaskSchema, request.body);
      const result = await dependencies.createTask.execute({
        ownerId: ownerId(request),
        projectId,
        ...body,
        idempotencyKey: request.header('idempotency-key') ?? ''
      });
      response.location(`/api/v1/projects/${projectId}/tasks/${result.task.id}`);
      response.setHeader('ETag', `"${result.orderVersion}"`);
      sendData(response, { task: serializeTask(result.task), orderVersion: result.orderVersion }, 201);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function updateTaskHandler(dependencies: ProjectTaskRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const projectId = parseId(routeParam(request.params.projectId));
      const taskId = parseId(routeParam(request.params.taskId));
      const body = parseBody(updateTaskSchema, request.body);
      const operationKey = request.header('idempotency-key');
      const result = await dependencies.updateTask.execute({
        ownerId: ownerId(request), projectId, taskId,
        expectedVersion: parseIfMatch(request.header('if-match')),
        ...(operationKey === undefined ? {} : { operationKey }),
        ...body
      });
      response.setHeader('ETag', `"${result.task.version}"`);
      sendData(response, { task: serializeTask(result.task), orderVersion: result.orderVersion });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function reorderTaskHandler(dependencies: ProjectTaskRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const projectId = parseId(routeParam(request.params.projectId));
      const body = parseBody(reorderTaskSchema, request.body);
      const result = await dependencies.reorderTask.execute({ ownerId: ownerId(request), projectId, taskId: parseId(body.taskId), direction: body.direction, expectedOrderVersion: parseIfMatch(request.header('if-match')) });
      response.setHeader('ETag', `"${result.orderVersion}"`);
      sendData(response, { tasks: result.tasks.map(serializeTask), orderVersion: result.orderVersion });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function listSuggestionsHandler(dependencies: ProjectTaskRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const projectId = parseId(routeParam(request.params.projectId));
      const conversationId = parseConversationQuery(request.query.conversationId);
      const suggestions = await dependencies.listSuggestions.execute({
        ownerId: ownerId(request),
        projectId,
        status: parseSuggestionFilter(request.query.status),
        ...(conversationId ? { conversationId } : {})
      });
      sendData(response, { taskSuggestions: suggestions.map(serializeSuggestion) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function resolveSuggestionHandler(dependencies: ProjectTaskRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const projectId = parseId(routeParam(request.params.projectId));
      const suggestionId = parseId(routeParam(request.params.suggestionId));
      const body = parseBody(resolveSuggestionSchema, request.body);
      const result = await dependencies.resolveSuggestion.execute({ ownerId: ownerId(request), projectId, suggestionId, expectedVersion: parseIfMatch(request.header('if-match')), ...body });
      response.setHeader('ETag', `"${result.taskSuggestion.version}"`);
      if (result.decision === 'accepted') {
        sendData(response, { task: serializeTask(result.task), taskSuggestion: serializeSuggestion(result.taskSuggestion), orderVersion: result.orderVersion });
        return;
      }
      sendData(response, { taskSuggestion: serializeSuggestion(result.taskSuggestion) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

export function createProjectTaskRouter(dependencies: ProjectTaskRouterDependencies): Router {
  const router = Router({ mergeParams: true });
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  router.get('/tasks', authenticate, listTasksHandler(dependencies));
  router.post('/tasks', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, createTaskHandler(dependencies));
  router.patch('/tasks/:taskId', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, updateTaskHandler(dependencies));
  router.patch('/task-order', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, reorderTaskHandler(dependencies));
  router.get('/task-suggestions', authenticate, listSuggestionsHandler(dependencies));
  router.patch('/task-suggestions/:suggestionId', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, resolveSuggestionHandler(dependencies));
  return router;
}
