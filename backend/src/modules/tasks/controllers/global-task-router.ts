import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { PROJECT_TASK_IMPORTANCES, PROJECT_TASK_STATUSES } from '@/modules/tasks/domain/project-task';
import type { GlobalTaskQueryFilters, GlobalTaskQueryItem } from '@/modules/tasks/domain/global-task-query';
import { ProjectTaskIdempotencyKeyError, ProjectTaskVersionRequiredError } from '@/modules/tasks/domain/project-task-errors';
import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';
import type { ITaskMutationCommands } from '@/modules/tasks/use-cases/task-mutation-use-cases';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';
import { CountInboxTasksUseCase, GetGlobalTaskUseCase, ListGlobalTasksUseCase } from '@/modules/tasks/use-cases/global-task-query-use-cases';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');
const deadlineQuery = z.string().regex(DATE_ONLY).refine(isCalendarDate);

const listQuerySchema = z.object({
  workspaceId: z.guid().optional(),
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
});

const detailQuerySchema = z.object({ includeArchived: booleanQuery.optional() }).strict();
const positiveVersion = z.number().int().positive().max(2147483647);
const subtaskSchema = z.object({ id: z.guid().optional(), title: z.string(), completed: z.boolean().optional() }).strict();
const createMutationSchema = z.object({
  title: z.string(),
  details: z.string().nullable().optional(),
  workspaceId: z.guid().nullable().optional(),
  importance: z.enum(PROJECT_TASK_IMPORTANCES).optional(),
  deadline: z.string().nullable().optional(),
  subtasks: z.array(subtaskSchema).max(50).optional(),
  expectedOrderVersion: positiveVersion.optional()
}).strict();
const updateMutationSchema = z.object({
  title: z.string().optional(),
  details: z.string().nullable().optional(),
  status: z.enum(['todo', 'in_progress', 'blocked', 'done']).optional(),
  importance: z.enum(PROJECT_TASK_IMPORTANCES).optional(),
  deadline: z.string().nullable().optional(),
  subtasks: z.array(subtaskSchema).max(50).optional()
}).strict().superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['request'], message: 'Provide at least one field to update.' });
  }
  if (value.status !== undefined && Object.keys(value).length > 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Send a status transition separately from field edits.' });
  }
});
const moveMutationSchema = z.object({
  workspaceId: z.guid().nullable(),
  expectedSourceOrderVersion: positiveVersion.optional(),
  expectedDestinationOrderVersion: positiveVersion.optional()
}).strict();

export interface GlobalTaskRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly countInboxTasks: CountInboxTasksUseCase;
  readonly listTasks: ListGlobalTasksUseCase;
  readonly getTask: GetGlobalTaskUseCase;
  readonly mutations?: ITaskMutationCommands;
  readonly appOrigin?: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && !value.startsWith('0000');
}

function parseQuery<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The global task query is invalid.', result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'query',
      message: issue.message
    })));
  }
  return result.data;
}

function parseMutationBody<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The task mutation request is invalid.', result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request',
      message: issue.message
    })));
  }
  return result.data;
}

function parseIfMatch(value: string | undefined): number {
  const match = value?.match(/^"([1-9]\d*)"$/u);
  const version = match?.[1] ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1 || version > 2147483647) {
    throw new ProjectTaskVersionRequiredError();
  }
  return version;
}

function requiredIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? '';
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(key)) {
    throw new ProjectTaskIdempotencyKeyError();
  }
  return key;
}

function serializeReceipt(record: ActionLedgerRecord): Record<string, unknown> {
  return {
    id: record.id,
    actionKind: record.actionKind,
    undoStatus: record.undoStatus,
    outcome: record.outcome
  };
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

function getInboxTaskCountHandler(dependencies: GlobalTaskRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      parseQuery(z.object({}).strict(), request.query);
      const count = await dependencies.countInboxTasks.execute({ ownerId: ownerId(request) });
      sendData(response, { count });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function createTaskMutationHandler(commands: ITaskMutationCommands): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const body = parseMutationBody(createMutationSchema, request.body);
      const { workspaceId, expectedOrderVersion, ...taskFields } = body;
      const result = await commands.create({
        ownerId: ownerId(request),
        operationKey: requiredIdempotencyKey(request.header('idempotency-key')),
        projectId: workspaceId ?? null,
        ...(expectedOrderVersion === undefined ? {} : { expectedOrderVersion }),
        ...taskFields
      });
      response.location(`/api/v1/tasks/${result.item.task.id}`);
      response.setHeader('ETag', `"${result.item.task.version}"`);
      sendData(response, { item: serializeItem(result.item), receipt: serializeReceipt(result.receipt), replayed: result.replayed }, 201);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function updateTaskMutationHandler(commands: ITaskMutationCommands): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const body = parseMutationBody(updateMutationSchema, request.body);
      const result = await commands.update({
        ownerId: ownerId(request),
        taskId: taskId(request.params.taskId),
        expectedVersion: parseIfMatch(request.header('if-match')),
        operationKey: requiredIdempotencyKey(request.header('idempotency-key')),
        ...body
      });
      response.setHeader('ETag', `"${result.item.task.version}"`);
      sendData(response, { item: serializeItem(result.item), receipt: serializeReceipt(result.receipt), replayed: result.replayed });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function moveTaskMutationHandler(commands: ITaskMutationCommands): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const body = parseMutationBody(moveMutationSchema, request.body);
      const result = await commands.move({
        ownerId: ownerId(request),
        taskId: taskId(request.params.taskId),
        expectedVersion: parseIfMatch(request.header('if-match')),
        operationKey: requiredIdempotencyKey(request.header('idempotency-key')),
        workspaceId: body.workspaceId,
        ...(body.expectedSourceOrderVersion === undefined ? {} : { expectedSourceOrderVersion: body.expectedSourceOrderVersion }),
        ...(body.expectedDestinationOrderVersion === undefined ? {} : { expectedDestinationOrderVersion: body.expectedDestinationOrderVersion })
      });
      response.setHeader('ETag', `"${result.item.task.version}"`);
      sendData(response, { item: serializeItem(result.item), receipt: serializeReceipt(result.receipt), replayed: result.replayed });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function deleteTaskMutationHandler(commands: ITaskMutationCommands): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const result = await commands.delete({
        ownerId: ownerId(request),
        taskId: taskId(request.params.taskId),
        expectedVersion: parseIfMatch(request.header('if-match')),
        operationKey: requiredIdempotencyKey(request.header('idempotency-key'))
      });
      response.setHeader('ETag', `"${result.orderVersion}"`);
      sendData(response, { taskId: result.taskId, orderVersion: result.orderVersion, receipt: serializeReceipt(result.receipt), replayed: result.replayed });
    } catch (error: unknown) {
      next(error);
    }
  };
}

export function createGlobalTaskRouter(dependencies: GlobalTaskRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  router.get('/tasks/inbox/count', authenticate, getInboxTaskCountHandler(dependencies));
  router.get('/tasks', authenticate, listTasksHandler(dependencies));
  router.get('/tasks/:taskId', authenticate, getTaskHandler(dependencies));
  if (dependencies.mutations) {
    const writeOrigin = sameOrigin(dependencies.appOrigin ?? '');
    router.post('/tasks', authenticate, writeOrigin, requireCsrf, createTaskMutationHandler(dependencies.mutations));
    router.patch('/tasks/:taskId', authenticate, writeOrigin, requireCsrf, updateTaskMutationHandler(dependencies.mutations));
    router.post('/tasks/:taskId/move', authenticate, writeOrigin, requireCsrf, moveTaskMutationHandler(dependencies.mutations));
    router.delete('/tasks/:taskId', authenticate, writeOrigin, requireCsrf, deleteTaskMutationHandler(dependencies.mutations));
  }
  return router;
}
