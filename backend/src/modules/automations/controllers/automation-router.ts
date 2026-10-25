import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import type {
  CreateAutomationScheduleUseCase,
  ListAutomationOccurrencesUseCase,
  ListAutomationSchedulesUseCase,
  RunAutomationNowUseCase,
  UpdateAutomationScheduleUseCase
} from '@/modules/automations/use-cases/automation-use-cases';
import type { AutomationOccurrence, AutomationSchedule } from '@/modules/automations/domain/automation-types';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const createSchema = z.object({
  workspaceId: z.guid(),
  skillId: z.guid(),
  skillVersion: z.number().int().positive(),
  localTime: z.string(),
  timeZone: z.string()
}).strict();
const updateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  skillId: z.guid().optional(),
  skillVersion: z.number().int().positive().optional(),
  localTime: z.string().optional(),
  timeZone: z.string().optional(),
  enabled: z.boolean().optional()
}).strict().refine((body) => Object.keys(body).some((key) => key !== 'expectedRevision'), 'Choose at least one schedule field to update.')
  .refine((body) => (body.skillId === undefined) === (body.skillVersion === undefined), 'skillId and skillVersion must be updated together.');
const emptySchema = z.object({}).strict();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AutomationRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly createSchedule: CreateAutomationScheduleUseCase;
  readonly listSchedules: ListAutomationSchedulesUseCase;
  readonly updateSchedule: UpdateAutomationScheduleUseCase;
  readonly runNow: RunAutomationNowUseCase;
  readonly listOccurrences: ListAutomationOccurrencesUseCase;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The automation request is invalid.', result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request', message: issue.message
    })));
  }
  return result.data;
}

function parseId(value: string | string[] | undefined): string {
  const id = Array.isArray(value) ? value[0] ?? '' : value ?? '';
  if (!UUID_PATTERN.test(id)) throw new AppError('AUTOMATION_NOT_FOUND', 404, 'The schedule is unavailable.');
  return id;
}

function ownerId(request: Parameters<RequestHandler>[0]): string {
  const id = request.auth?.principal.id;
  if (!id) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
  return id;
}

function serializeSchedule(schedule: AutomationSchedule): Record<string, unknown> {
  return {
    id: schedule.id,
    workspaceId: schedule.workspaceId,
    conversationId: schedule.conversationId,
    skillId: schedule.skillId,
    skillVersion: schedule.skillVersion,
    localTime: schedule.localTime,
    timeZone: schedule.timeZone,
    enabled: schedule.enabled,
    revision: schedule.revision,
    nextDueAt: schedule.nextDueAt?.toISOString() ?? null,
    lastRunStatus: schedule.lastRunStatus,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString()
  };
}

function serializeOccurrence(occurrence: AutomationOccurrence): Record<string, unknown> {
  const budgetSkipped = occurrence.status === 'skipped' && occurrence.failureCode === 'BUDGET_EXHAUSTED';
  return {
    id: occurrence.id,
    kind: occurrence.kind,
    intendedFor: occurrence.intendedFor.toISOString(),
    status: occurrence.status,
    scheduleRevision: occurrence.scheduleRevision,
    skillVersion: occurrence.skillVersion,
    homeTurnId: budgetSkipped ? null : occurrence.homeTurnId,
    failureCode: occurrence.failureCode,
    attemptCount: occurrence.attemptCount,
    taskSources: (occurrence.taskSources ?? []).map((source) => ({
      taskId: source.taskId,
      revision: source.revision,
      available: source.available,
      title: source.available ? source.title : null,
      href: source.available ? source.href : null
    })),
    providerUsage: occurrence.providerUsage ?? { state: budgetSkipped || !occurrence.homeTurnId ? 'not_started' : 'unknown', calls: [] },
    createdAt: occurrence.createdAt.toISOString(),
    updatedAt: occurrence.updatedAt.toISOString()
  };
}

function handler(action: (request: Parameters<RequestHandler>[0], response: Parameters<RequestHandler>[1]) => Promise<void>): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try { await action(request, response); } catch (error: unknown) { next(error); }
  };
}

export function createAutomationRouter(dependencies: AutomationRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);

  router.get('/schedules', authenticate, handler(async (request, response) => {
    const schedules = await dependencies.listSchedules.execute({ ownerId: ownerId(request) });
    sendData(response, { schedules: schedules.map(serializeSchedule) });
  }));

  router.post('/schedules', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, handler(async (request, response) => {
    const result = await dependencies.createSchedule.execute({
      ownerId: ownerId(request),
      idempotencyKey: request.header('idempotency-key'),
      ...parseBody(createSchema, request.body)
    });
    response.location(`/api/v1/automations/schedules/${result.schedule.id}`);
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    sendData(response, { schedule: serializeSchedule(result.schedule) }, 201);
  }));

  router.patch('/schedules/:scheduleId', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, handler(async (request, response) => {
    const schedule = await dependencies.updateSchedule.execute({
      ownerId: ownerId(request),
      scheduleId: parseId(request.params.scheduleId),
      ...parseBody(updateSchema, request.body)
    });
    sendData(response, { schedule: serializeSchedule(schedule) });
  }));

  router.post('/schedules/:scheduleId/runs', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, handler(async (request, response) => {
    parseBody(emptySchema, request.body ?? {});
    const result = await dependencies.runNow.execute({
      ownerId: ownerId(request),
      scheduleId: parseId(request.params.scheduleId),
      idempotencyKey: request.header('idempotency-key')
    });
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    sendData(response, { occurrence: serializeOccurrence(result.occurrence) }, result.replayed ? 200 : 202);
  }));

  router.get('/schedules/:scheduleId/occurrences', authenticate, handler(async (request, response) => {
    const rawLimit = request.query.limit;
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError('VALIDATION_ERROR', 400, 'limit must be an integer from 1 to 100.');
    const before = typeof request.query.before === 'string' ? request.query.before : undefined;
    if (before !== undefined && (before.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(before))) {
      throw new AppError('VALIDATION_ERROR', 400, 'The occurrence cursor is invalid.');
    }
    const page = await dependencies.listOccurrences.execute({ ownerId: ownerId(request), scheduleId: parseId(request.params.scheduleId), limit, ...(before ? { before } : {}) });
    sendData(response, { occurrences: page.occurrences.map(serializeOccurrence), nextCursor: page.nextCursor });
  }));

  return router;
}
