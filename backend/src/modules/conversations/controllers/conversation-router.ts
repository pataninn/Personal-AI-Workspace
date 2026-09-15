import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import {
  ConversationNotFoundError,
  ConversationQueryInvalidError,
  ProjectArchivedError
} from '@/modules/conversations/domain/conversation-errors';
import { parseBeforeSequence, parsePositiveLimit } from '@/modules/conversations/domain/conversation-validation';
import type { Conversation, Message, MessagePage } from '@/modules/conversations/domain/conversation-types';
import {
  AddUserMessageUseCase,
  CreateConversationUseCase,
  GetConversationUseCase,
  ListConversationsUseCase
} from '@/modules/conversations/use-cases';
import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const createConversationSchema = z.object({ title: z.string() }).strict();
const createMessageSchema = z.object({ content: z.string() }).strict();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ConversationRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly listConversations: ListConversationsUseCase;
  readonly createConversation: CreateConversationUseCase;
  readonly getConversation: GetConversationUseCase;
  readonly addUserMessage: AddUserMessageUseCase;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The conversation request is invalid.', result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request',
      message: issue.message
    })));
  }
  return result.data;
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ConversationQueryInvalidError(field, 'Use one value for this query parameter.');
  }
  return value;
}

function requiredQueryString(value: unknown, field: string): string {
  const parsed = queryString(value, field);
  if (!parsed) {
    throw new ConversationQueryInvalidError(field, `${field} is required.`);
  }
  return parsed;
}

function parseUuid(value: unknown, notFound: Error): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw notFound;
  }
  return value;
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function idempotencyKey(request: Parameters<RequestHandler>[0]): string {
  return request.header('idempotency-key') ?? '';
}

function serializeConversation(conversation: Conversation): Record<string, unknown> {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title,
    status: conversation.status,
    lastActivityAt: conversation.lastActivityAt.toISOString(),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString()
  };
}

function serializeMessage(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    sequence: message.sequence,
    content: message.content,
    createdAt: message.createdAt.toISOString()
  };
}

function listHandler(dependencies: ConversationRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projectId = parseUuid(routeParam(request.params.projectId), new ConversationNotFoundError());
      const limit = parsePositiveLimit(request.query.limit, 50, 100, 'limit');
      const cursor = queryString(request.query.cursor, 'cursor');
      const result = await dependencies.listConversations.execute({ ownerId, projectId, limit, ...(cursor ? { cursor } : {}) });
      sendData(response, {
        conversations: result.conversations.map(serializeConversation),
        nextCursor: result.nextCursor
      });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function createHandler(dependencies: ConversationRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projectId = parseUuid(routeParam(request.params.projectId), new ConversationNotFoundError());
      const result = await dependencies.createConversation.execute({
        ownerId,
        projectId,
        idempotencyKey: idempotencyKey(request),
        ...parseBody(createConversationSchema, request.body)
      });
      const location = `/api/v1/conversations/${result.resource.id}?projectId=${encodeURIComponent(projectId)}`;
      response.location(location);
      sendData(response, serializeConversation(result.resource), result.replayed ? 200 : 201);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function getHandler(dependencies: ConversationRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const conversationId = parseUuid(routeParam(request.params.conversationId), new ConversationNotFoundError());
      const projectId = parseUuid(requiredQueryString(request.query.projectId, 'projectId'), new ConversationNotFoundError());
      const beforeSequence = parseBeforeSequence(request.query.beforeSequence);
      const result = await dependencies.getConversation.execute({
        ownerId,
        projectId,
        conversationId,
        limit: parsePositiveLimit(request.query.limit, 200, 200, 'limit'),
        ...(beforeSequence === undefined ? {} : { beforeSequence })
      });
      sendData(response, serializeHistory(result));
    } catch (error: unknown) {
      next(error);
    }
  };
}

function messageHandler(dependencies: ConversationRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const conversationId = parseUuid(routeParam(request.params.conversationId), new ConversationNotFoundError());
      const projectId = parseUuid(requiredQueryString(request.query.projectId, 'projectId'), new ConversationNotFoundError());
      const result = await dependencies.addUserMessage.execute({
        ownerId,
        projectId,
        conversationId,
        idempotencyKey: idempotencyKey(request),
        ...parseBody(createMessageSchema, request.body)
      });
      const location = `/api/v1/conversations/${conversationId}/messages?projectId=${encodeURIComponent(projectId)}`;
      response.location(location);
      sendData(response, serializeMessage(result.resource), result.replayed ? 200 : 201);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function serializeHistory(result: MessagePage): Record<string, unknown> {
  return {
    conversation: serializeConversation(result.conversation),
    messages: result.messages.map(serializeMessage),
    nextBeforeSequence: result.nextBeforeSequence
  };
}

export function createConversationRouter(dependencies: ConversationRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  router.get('/projects/:projectId/conversations', authenticate, listHandler(dependencies));
  router.post('/projects/:projectId/conversations', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, createHandler(dependencies));
  router.get('/conversations/:conversationId', authenticate, getHandler(dependencies));
  router.post('/conversations/:conversationId/messages', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, messageHandler(dependencies));
  return router;
}
