import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { SKILL_TEMPLATES, type Skill } from '@/modules/skills/domain/skill-types';
import type { CreateSkillUseCase } from '@/modules/skills/use-cases/create-skill';
import type { DeleteSkillUseCase } from '@/modules/skills/use-cases/delete-skill';
import type { GetSkillUseCase } from '@/modules/skills/use-cases/get-skill';
import type { ListSkillsUseCase } from '@/modules/skills/use-cases/list-skills';
import type { UpdateSkillUseCase } from '@/modules/skills/use-cases/update-skill';
import type { InvokeSkillUseCase } from '@/modules/skills/use-cases/invoke-skill';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const createSchema = z.object({
  templateId: z.enum(['plan-my-day', 'daily-briefing']).optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  title: z.string().optional(),
  instructions: z.string().optional(),
  declaredTools: z.array(z.string()).optional()
}).strict();
const updateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  workspaceId: z.string().uuid().nullable().optional(),
  title: z.string().optional(),
  instructions: z.string().optional(),
  declaredTools: z.array(z.string()).optional(),
  enabled: z.boolean().optional()
}).strict().refine((body) => Object.keys(body).some((key) => key !== 'expectedVersion'), 'Choose at least one skill field to update.');
const invokeSchema = z.object({
  conversationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  request: z.string()
}).strict();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface SkillRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly listSkills: ListSkillsUseCase;
  readonly getSkill: GetSkillUseCase;
  readonly createSkill: CreateSkillUseCase;
  readonly updateSkill: UpdateSkillUseCase;
  readonly deleteSkill: DeleteSkillUseCase;
  readonly invokeSkill: InvokeSkillUseCase;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The skill request is invalid.', result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request',
      message: issue.message
    })));
  }
  return result.data;
}

function parseId(value: string | string[] | undefined): string {
  const id = Array.isArray(value) ? value[0] ?? '' : value ?? '';
  if (!UUID_PATTERN.test(id)) throw new AppError('SKILL_NOT_FOUND', 404, 'The skill is unavailable.');
  return id;
}

function ownerId(request: Parameters<RequestHandler>[0]): string {
  const id = request.auth?.principal.id;
  if (!id) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
  return id;
}

function serializeSkill(skill: Skill): Record<string, unknown> {
  return {
    id: skill.id,
    workspaceId: skill.workspaceId,
    title: skill.title,
    instructions: skill.instructions,
    declaredTools: skill.declaredTools,
    enabled: skill.enabled,
    version: skill.version,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString()
  };
}

function handler(action: (request: Parameters<RequestHandler>[0], response: Parameters<RequestHandler>[1]) => Promise<void>): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      await action(request, response);
    } catch (error: unknown) {
      next(error);
    }
  };
}

export function createSkillRouter(dependencies: SkillRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  router.get('/templates', authenticate, handler(async (_request, response) => {
    sendData(response, { templates: SKILL_TEMPLATES });
  }));
  router.get('/', authenticate, handler(async (request, response) => {
    const workspaceId = typeof request.query.workspaceId === 'string' ? request.query.workspaceId : undefined;
    if (request.query.workspaceId !== undefined && (!workspaceId || !UUID_PATTERN.test(workspaceId))) {
      throw new AppError('VALIDATION_ERROR', 400, 'The workspace filter is invalid.', [{ field: 'workspaceId', message: 'Use a workspace UUID.' }]);
    }
    const skills = await dependencies.listSkills.execute({ ownerId: ownerId(request), ...(workspaceId ? { workspaceId } : {}) });
    sendData(response, { skills: skills.map(serializeSkill) });
  }));
  router.post('/', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, handler(async (request, response) => {
    const body = parseBody(createSchema, request.body);
    const result = await dependencies.createSkill.execute({
      ownerId: ownerId(request),
      idempotencyKey: request.header('idempotency-key'),
      ...body
    });
    response.location(`/api/v1/skills/${result.skill.id}`);
    if (result.replayed) response.setHeader('Idempotency-Replayed', 'true');
    sendData(response, { skill: serializeSkill(result.skill) }, 201);
  }));
  router.get('/:skillId', authenticate, handler(async (request, response) => {
    const skill = await dependencies.getSkill.execute({ ownerId: ownerId(request), skillId: parseId(request.params.skillId) });
    sendData(response, { skill: serializeSkill(skill) });
  }));
  router.patch('/:skillId', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, handler(async (request, response) => {
    const skill = await dependencies.updateSkill.execute({
      ownerId: ownerId(request),
      skillId: parseId(request.params.skillId),
      ...parseBody(updateSchema, request.body)
    });
    sendData(response, { skill: serializeSkill(skill) });
  }));
  router.delete('/:skillId', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, handler(async (request, response) => {
    const match = request.header('if-match')?.match(/^"([1-9]\d*)"$/u);
    const expectedVersion = match?.[1] ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(expectedVersion)) {
      throw new AppError('SKILL_VERSION_REQUIRED', 428, 'Send the current skill version in If-Match.');
    }
    await dependencies.deleteSkill.execute({ ownerId: ownerId(request), skillId: parseId(request.params.skillId), expectedVersion });
    response.status(204).end();
  }));
  router.post('/:skillId/invocations', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, handler(async (request, response) => {
    const body = parseBody(invokeSchema, request.body);
    const result = await dependencies.invokeSkill.execute({
      ownerId: ownerId(request),
      skillId: parseId(request.params.skillId),
      requestKey: request.header('idempotency-key'),
      ...body
    });
    sendData(response, result);
  }));
  return router;
}
