import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { HomeConversationNotFoundError, HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import type { HomeConversation, HomeConversationEvent, HomeMessage, HomeTurn, HomeTurnSubmission } from '@/modules/home-assistant/domain/home-conversation-types';
import type { DecideHomeConsentUseCase } from '@/modules/home-assistant/use-cases/decide-home-consent';
import type { CreateHomeConversationUseCase } from '@/modules/home-assistant/use-cases/create-home-conversation';
import type { GetHomeConversationUseCase } from '@/modules/home-assistant/use-cases/get-home-conversation';
import type { ListHomeConversationsUseCase } from '@/modules/home-assistant/use-cases/list-home-conversations';
import type { ListHomeTurnsUseCase } from '@/modules/home-assistant/use-cases/list-home-turns';
import type { SubmitHomeTurnUseCase } from '@/modules/home-assistant/use-cases/submit-home-turn';
import type { GetHomeTurnUseCase } from '@/modules/home-assistant/use-cases/get-home-turn';
import type { CancelHomeTurnUseCase } from '@/modules/home-assistant/use-cases/cancel-home-turn';
import type { ListHomeMessagesUseCase } from '@/modules/home-assistant/use-cases/list-home-messages';
import type { ListHomeEventsUseCase } from '@/modules/home-assistant/use-cases/list-home-events';
import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { AppError } from '@/shared/errors/app-error';
import { PolicyActionRetiredError } from '@/modules/assistant-policy/domain/policy-action-retired-error';
import { sendData } from '@/shared/http/response';

const UUID = z.string().uuid();
const createConversationBody = z.object({
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('home') }).strict(),
    z.object({ kind: z.literal('workspace'), workspaceId: UUID }).strict()
  ]),
  title: z.string().min(1).max(160)
}).strict();
const submitTurnBody = z.object({ message: z.string().min(1).max(20000) }).strict();

export interface HomeConversationRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly listConversations: ListHomeConversationsUseCase;
  readonly createConversation: CreateHomeConversationUseCase;
  readonly getConversation: GetHomeConversationUseCase;
  readonly listTurns: ListHomeTurnsUseCase;
  readonly submitTurn: SubmitHomeTurnUseCase;
  readonly decideConsent: DecideHomeConsentUseCase;
  readonly getTurn: GetHomeTurnUseCase;
  readonly cancelTurn: CancelHomeTurnUseCase;
  readonly listMessages: ListHomeMessagesUseCase;
  readonly listEvents: ListHomeEventsUseCase;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, description: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 400, description, parsed.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request',
      message: issue.message
    })));
  }
  return parsed.data;
}

function ownerId(request: Request): string {
  const id = request.auth?.principal.id;
  if (!id) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
  return id;
}

function queryValue(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AppError('VALIDATION_ERROR', 400, `Use one value for ${field}.`);
  return value;
}

function parseIntegerQuery(value: unknown, field: string, fallback: number, maximum: number): number {
  const raw = queryValue(value, field);
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) throw new AppError('VALIDATION_ERROR', 400, `${field} must be a non-negative integer.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new AppError('VALIDATION_ERROR', 400, `${field} is outside the supported range.`);
  return parsed;
}

function parseLimit(value: unknown): number {
  const raw = queryValue(value, 'limit');
  if (raw === undefined) return 50;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new AppError('VALIDATION_ERROR', 400, 'limit must be a positive integer.');
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit > 100) throw new AppError('VALIDATION_ERROR', 400, 'limit must be between 1 and 100.');
  return limit;
}

function parseScope(request: Request): { readonly kind: 'home' } | { readonly kind: 'workspace'; readonly workspaceId: string } {
  const kind = queryValue(request.query.scope, 'scope');
  const workspaceId = queryValue(request.query.workspaceId, 'workspaceId');
  if (kind === 'home' && workspaceId === undefined) return { kind: 'home' };
  if (kind === 'workspace' && UUID.safeParse(workspaceId).success) return { kind: 'workspace', workspaceId: workspaceId as string };
  throw new AppError('VALIDATION_ERROR', 400, 'scope must be home or workspace; workspace scope requires a UUID workspaceId.');
}

function parseUuid(value: string | string[] | undefined, error: Error): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!UUID.safeParse(raw).success) throw error;
  return raw as string;
}

function serializeConversation(value: HomeConversation): Record<string, unknown> {
  return {
    id: value.id,
    scope: value.scope,
    title: value.title,
    lastEventSequence: value.lastEventSequence,
    lastActivityAt: value.lastActivityAt.toISOString(),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString()
  };
}

function serializeTurn(value: HomeTurn): Record<string, unknown> {
  return {
    id: value.id,
    conversationId: value.conversationId,
    sequence: value.sequence,
    status: value.status,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString()
  };
}

function serializeMessage(value: HomeMessage): Record<string, unknown> {
  return {
    id: value.id,
    turnId: value.turnId,
    sequence: value.sequence,
    role: value.role,
    content: value.content,
    createdAt: value.createdAt.toISOString()
  };
}

function serializeEvent(value: HomeConversationEvent): Record<string, unknown> {
  return {
    sequence: value.sequence,
    type: value.type,
    turnId: value.turnId,
    entityId: value.entityId,
    payload: value.payload,
    createdAt: value.createdAt.toISOString()
  };
}

function serializeConsentDisclosure(value: NonNullable<HomeTurnSubmission['disclosure']>): Record<string, unknown> {
  return {
    disclosureId: value.disclosureId,
    phase: value.phase,
    provider: { profile: value.providerProfile, name: value.providerName, model: value.model },
    scope: value.scope,
    categories: value.categories,
    itemCount: value.itemCount,
    byteLimit: value.byteLimit
  };
}

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next): void => {
    void handler(request, response).catch(next);
  };
}

export function createHomeConversationRouter(dependencies: HomeConversationRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);

  router.get('/home/conversations', authenticate, route(async (request, response) => {
    const cursor = queryValue(request.query.cursor, 'cursor');
    const result = await dependencies.listConversations.execute({
      ownerId: ownerId(request),
      scope: parseScope(request),
      limit: parseLimit(request.query.limit),
      ...(cursor === undefined ? {} : { cursor })
    });
    sendData(response, { conversations: result.conversations.map(serializeConversation), nextCursor: result.nextCursor });
  }));

  router.post('/home/conversations', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, route(async (request, response) => {
    const body = parseBody(createConversationBody, request.body, 'The Home conversation request is invalid.');
    const result = await dependencies.createConversation.execute({
      ownerId: ownerId(request),
      ...body,
      requestKey: request.header('idempotency-key') ?? ''
    });
    response.location(`/api/v1/home/conversations/${result.resource.id}`);
    sendData(response, { ...serializeConversation(result.resource), replayed: result.replayed }, result.replayed ? 200 : 201);
  }));

  router.get('/home/conversations/:conversationId', authenticate, route(async (request, response) => {
    const conversationId = parseUuid(request.params.conversationId, new HomeConversationNotFoundError());
    const result = await dependencies.getConversation.execute({ ownerId: ownerId(request), conversationId });
    sendData(response, serializeConversation(result));
  }));

  router.get('/home/conversations/:conversationId/turns', authenticate, route(async (request, response) => {
    const conversationId = parseUuid(request.params.conversationId, new HomeConversationNotFoundError());
    const afterSequence = request.query.afterSequence === undefined ? undefined : parseIntegerQuery(request.query.afterSequence, 'afterSequence', 0, 2147483647);
    const result = await dependencies.listTurns.execute({
      ownerId: ownerId(request), conversationId, limit: parseLimit(request.query.limit),
      ...(afterSequence === undefined ? {} : { afterSequence })
    });
    sendData(response, { turns: result.turns.map(serializeTurn), nextAfterSequence: result.nextAfterSequence });
  }));

  router.post('/home/conversations/:conversationId/turns', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, route(async (request, response) => {
    const conversationId = parseUuid(request.params.conversationId, new HomeConversationNotFoundError());
    const body = parseBody(submitTurnBody, request.body, 'The Home turn request is invalid.');
    const result: HomeTurnSubmission = await dependencies.submitTurn.execute({
      ownerId: ownerId(request), conversationId, requestKey: request.header('idempotency-key') ?? '', message: body.message
    });
    response.location(`/api/v1/home/conversations/${conversationId}/turns/${result.turn.id}`);
    sendData(response, {
      turn: serializeTurn(result.turn),
      message: serializeMessage(result.message),
      execution: result.execution?.state === 'consent_required' && result.disclosure
        ? { state: 'consent_required', disclosure: serializeConsentDisclosure(result.disclosure) }
        : result.execution ?? { state: 'unsupported', code: 'PLANNING_RUNTIME_UNAVAILABLE' },
      replayed: result.replayed
    }, result.replayed ? 200 : 201);
  }));

  router.get('/home/conversations/:conversationId/turns/:turnId', authenticate, route(async (request, response) => {
    const conversationId = parseUuid(request.params.conversationId, new HomeConversationNotFoundError());
    const turnId = parseUuid(request.params.turnId, new HomeTurnNotFoundError());
    const result = await dependencies.getTurn.execute({ ownerId: ownerId(request), conversationId, turnId });
    sendData(response, serializeTurn(result));
  }));

  router.post('/home/conversations/:conversationId/turns/:turnId/cancellation', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, route(async (request, response) => {
    const conversationId = parseUuid(request.params.conversationId, new HomeConversationNotFoundError());
    const turnId = parseUuid(request.params.turnId, new HomeTurnNotFoundError());
    const result = await dependencies.cancelTurn.execute({ ownerId: ownerId(request), conversationId, turnId });
    sendData(response, { turn: serializeTurn(result.resource), replayed: result.replayed });
  }));

  router.post('/home/conversations/:conversationId/turns/:turnId/consent-decisions', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, route(async (request, _response) => {
    ownerId(request);
    throw new PolicyActionRetiredError();
  }));

  router.get('/home/conversations/:conversationId/messages', authenticate, route(async (request, response) => {
    const conversationId = parseUuid(request.params.conversationId, new HomeConversationNotFoundError());
    const beforeSequence = request.query.beforeSequence === undefined ? undefined : parseIntegerQuery(request.query.beforeSequence, 'beforeSequence', 0, 2147483647);
    const result = await dependencies.listMessages.execute({
      ownerId: ownerId(request), conversationId, limit: parseLimit(request.query.limit),
      ...(beforeSequence === undefined ? {} : { beforeSequence })
    });
    sendData(response, { messages: result.messages.map(serializeMessage), nextBeforeSequence: result.nextBeforeSequence });
  }));

  router.get('/home/conversations/:conversationId/events', authenticate, route(async (request, response) => {
    const conversationId = parseUuid(request.params.conversationId, new HomeConversationNotFoundError());
    const afterSequence = parseIntegerQuery(request.query.afterSequence, 'afterSequence', 0, 2147483647);
    const result = await dependencies.listEvents.execute({ ownerId: ownerId(request), conversationId, afterSequence, limit: parseLimit(request.query.limit) });
    sendData(response, {
      events: result.events.map(serializeEvent),
      nextAfterSequence: result.nextAfterSequence,
      lastEventSequence: result.lastEventSequence
    });
  }));

  return router;
}
