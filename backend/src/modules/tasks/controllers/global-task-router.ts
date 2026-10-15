import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { PROJECT_TASK_IMPORTANCES, PROJECT_TASK_STATUSES } from '@/modules/tasks/domain/project-task';
import type { GlobalTaskQueryFilters, GlobalTaskQueryItem } from '@/modules/tasks/domain/global-task-query';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';
import { GetGlobalTaskUseCase, ListGlobalTasksUseCase } from '@/modules/tasks/use-cases/global-task-query-use-cases';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');
const deadlineQuery = z.string().regex(DATE_ONLY).refine(isCalendarDate);

const listQuerySchema = z.object({
  workspaceId: z.string().uuid().optional(),
  inboxOnly: booleanQuery.optional(),
  status: z.enum(PROJECT_TASK_STATUSES).optional(),
  importance: z.enum(PROJECT_TASK_IMPORTANCES).optional(),
  deadlineFrom: deadlineQuery.optional(),
  deadlineTo: deadlineQuery.optional(),
  q: z.string().trim().max(200).optional().transform((value) => value || undefined),
  includeArchived: booleanQuery.optional(),
  limit: z.string().regex(/^[1-9]\d*$/u).transform(Number).refine((value) => value <= 100).optional(),
  cursor: z.string().min(1).max(1024).optional()
}).strict().superRefine((value, context) => {
  if (value.workspaceId && value.inboxOnly === true) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['inboxOnly'], message: 'Choose either Inbox or one workspace.' });
  }
  if (value.deadlineFrom && value.deadlineTo && value.deadlineFrom > value.deadlineTo) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['deadlineFrom'], message: 'The start date must not be later than the end date.' });
  }
  if (value.status === 'archived' && value.includeArchived !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['includeArchived'], message: 'Set includeArchived to true to query archived tasks.' });
  }
});

const detailQuerySchema = z.object({ includeArchived: booleanQuery.optional() }).strict();

export interface GlobalTaskRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly listTasks: ListGlobalTasksUseCase;
  readonly getTask: GetGlobalTaskUseCase;
  readonly clearSessionCookie: (response: Response) => void;
}

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && !value.startsWith('0000');
}

function parseQuery<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The global task query is invalid.', result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'query',
      message: issue.message
    })));
  }
  return result.data;
}

function ownerId(request: Parameters<RequestHandler>[0]): string {
  const id = request.auth?.principal.id;
  if (!id) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
  return id;
}

function taskId(value: string | string[] | undefined): string {
  const id = Array.isArray(value) ? value[0] : value;
  if (!id || !UUID.test(id)) {
    throw new AppError('VALIDATION_ERROR', 400, 'The global task query is invalid.', [{ field: 'taskId', message: 'Use a task UUID.' }]);
  }
  return id;
}

function serializeItem(item: GlobalTaskQueryItem): Record<string, unknown> {
  return {
    ...item,
    task: {
      ...item.task,
      createdAt: item.task.createdAt.toISOString(),
      updatedAt: item.task.updatedAt.toISOString(),
      completedAt: item.task.completedAt?.toISOString() ?? null,
      archivedAt: item.task.archivedAt?.toISOString() ?? null,
      source: { ...item.task.source, acceptedAt: item.task.source.acceptedAt?.toISOString() ?? null }
    }
  };
}

function listTasksHandler(dependencies: GlobalTaskRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const parsed = parseQuery(listQuerySchema, request.query);
      const filters: GlobalTaskQueryFilters = {
        ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
        inboxOnly: parsed.inboxOnly ?? false,
        ...(parsed.status ? { status: parsed.status } : {}),
        ...(parsed.importance ? { importance: parsed.importance } : {}),
        ...(parsed.deadlineFrom ? { deadlineFrom: parsed.deadlineFrom } : {}),
        ...(parsed.deadlineTo ? { deadlineTo: parsed.deadlineTo } : {}),
        ...(parsed.q ? { q: parsed.q } : {}),
        includeArchived: parsed.includeArchived ?? false,
        limit: parsed.limit ?? 25
      };
      const page = await dependencies.listTasks.execute({ ownerId: ownerId(request), filters, ...(parsed.cursor ? { cursor: parsed.cursor } : {}) });
      sendData(response, { items: page.items.map(serializeItem), nextCursor: page.nextCursor });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function getTaskHandler(dependencies: GlobalTaskRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const query = parseQuery(detailQuerySchema, request.query);
      const item = await dependencies.getTask.execute({
        ownerId: ownerId(request),
        taskId: taskId(request.params.taskId),
        includeArchived: query.includeArchived ?? false
      });
      sendData(response, serializeItem(item));
    } catch (error: unknown) {
      next(error);
    }
  };
}

export function createGlobalTaskRouter(dependencies: GlobalTaskRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  router.get('/tasks', authenticate, listTasksHandler(dependencies));
  router.get('/tasks/:taskId', authenticate, getTaskHandler(dependencies));
  return router;
}
