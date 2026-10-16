import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { HomeConversationNotFoundError, HomeTurnNotFoundError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { HomeProposalNotFoundError } from '@/modules/home-assistant/domain/home-planning-errors';
import type { HomeChangeProposal } from '@/modules/home-assistant/domain/home-change-proposal-types';
import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import type { HomeChangeProposalUseCases } from '@/modules/home-assistant/use-cases/home-change-proposal-use-cases';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const UUID = z.string().uuid();
const revisionSchema = z.number().int().positive().max(2147483647);
const acceptBody = z.object({ expectedRevision: revisionSchema }).strict();
const cancelBody = z.object({ expectedRevision: revisionSchema }).strict();
const editBody = z.object({ expectedRevision: revisionSchema, changes: z.record(z.unknown()) }).strict();
const listStates = z.enum(['review_required', 'accepted', 'executing', 'partial', 'completed', 'cancelled', 'unknown']);

export interface HomeProposalRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly proposals: HomeChangeProposalUseCases;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next): void => { void handler(request, response).catch(next); };
}

function ownerId(request: Request): string {
  const id = request.auth?.principal.id;
  if (!id) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
  return id;
}

function uuid(value: string | string[] | undefined, missing: Error): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!UUID.safeParse(candidate).success) throw missing;
  return candidate as string;
}

function body<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_ERROR', 400, 'The Home proposal request is invalid.', result.error.issues.map((issue) => ({ field: issue.path.join('.') || 'request', message: issue.message })));
  return result.data;
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AppError('VALIDATION_ERROR', 400, `Use one value for ${field}.`);
  return value;
}

function parseLimit(value: unknown): number {
  const raw = queryString(value, 'limit');
  if (raw === undefined) return 20;
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new AppError('VALIDATION_ERROR', 400, 'limit must be a positive integer.');
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit > 50) throw new AppError('VALIDATION_ERROR', 400, 'limit must be between 1 and 50.');
  return limit;
}

function expectedIfMatch(request: Request): number {
  const value = request.header('if-match');
  const match = value?.match(/^"?([1-9][0-9]*)"?$/u);
  const revision = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(revision) || revision > 2147483647) throw new AppError('VALIDATION_ERROR', 400, 'If-Match must contain the current proposal revision.');
  return revision;
}

function serializeProposal(value: HomeChangeProposal): Record<string, unknown> {
  return {
    id: value.id,
    sourceTurnId: value.sourceTurnId,
    scope: value.scope,
    state: value.state,
    revision: value.revision,
    acceptedRevision: value.acceptedRevision,
    acceptanceId: value.acceptanceId,
    itemCount: value.itemCount,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
    items: value.items.map((item) => ({
      id: item.id,
      position: item.position,
      action: item.action,
      command: item.command,
      deadlineResolution: item.deadlineResolution,
      state: item.state,
      receiptId: item.receiptId,
      resultCode: item.resultCode
    }))
  };
}

export function createHomeProposalRouter(dependencies: HomeProposalRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  const base = '/home/conversations/:conversationId/proposals';

  router.get(base, authenticate, route(async (request, response) => {
    const conversationId = uuid(request.params.conversationId, new HomeConversationNotFoundError());
    const rawState = queryString(request.query.state, 'state');
    const parsedState = rawState === undefined ? undefined : listStates.safeParse(rawState);
    if (parsedState && !parsedState.success) throw new AppError('VALIDATION_ERROR', 400, 'The proposal state is invalid.', [{ field: 'state', message: 'Choose a supported proposal state.' }]);
    const state = parsedState?.success ? parsedState.data : undefined;
    const cursor = queryString(request.query.cursor, 'cursor');
    if (cursor !== undefined && cursor.length > 1024) throw new AppError('VALIDATION_ERROR', 400, 'The proposal cursor is invalid.');
    const result = await dependencies.proposals.list({ ownerId: ownerId(request), conversationId, limit: parseLimit(request.query.limit), ...(state ? { state } : {}), ...(cursor ? { cursor } : {}) });
    sendData(response, result);
  }));

  router.get(`${base}/:proposalId`, authenticate, route(async (request, response) => {
    const conversationId = uuid(request.params.conversationId, new HomeConversationNotFoundError());
    const proposalId = uuid(request.params.proposalId, new HomeProposalNotFoundError());
    sendData(response, { proposal: serializeProposal(await dependencies.proposals.get(ownerId(request), conversationId, proposalId)) });
  }));

  router.patch(`${base}/:proposalId/items/:itemId`, sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, route(async (request, response) => {
    const conversationId = uuid(request.params.conversationId, new HomeConversationNotFoundError());
    const proposalId = uuid(request.params.proposalId, new HomeProposalNotFoundError());
    const itemId = uuid(request.params.itemId, new HomeProposalNotFoundError());
    const input = body(editBody, request.body);
    const proposal = await dependencies.proposals.editItem({ ownerId: ownerId(request), conversationId, proposalId, itemId, expectedRevision: input.expectedRevision, changes: input.changes });
    response.setHeader('ETag', `"${proposal.revision}"`);
    sendData(response, { proposal: serializeProposal(proposal) });
  }));

  router.delete(`${base}/:proposalId/items/:itemId`, sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, route(async (request, response) => {
    const conversationId = uuid(request.params.conversationId, new HomeConversationNotFoundError());
    const proposalId = uuid(request.params.proposalId, new HomeProposalNotFoundError());
    const itemId = uuid(request.params.itemId, new HomeProposalNotFoundError());
    const proposal = await dependencies.proposals.removeItem({ ownerId: ownerId(request), conversationId, proposalId, itemId, expectedRevision: expectedIfMatch(request) });
    response.setHeader('ETag', `"${proposal.revision}"`);
    sendData(response, { proposal: serializeProposal(proposal) });
  }));

  router.post(`${base}/:proposalId/acceptance`, sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, route(async (request, response) => {
    const conversationId = uuid(request.params.conversationId, new HomeConversationNotFoundError());
    const proposalId = uuid(request.params.proposalId, new HomeProposalNotFoundError());
    const input = body(acceptBody, request.body);
    const result = await dependencies.proposals.accept({ ownerId: ownerId(request), conversationId, proposalId, expectedRevision: input.expectedRevision });
    response.location(`/api/v1/home/conversations/${conversationId}/proposals/${proposalId}/acceptance/${result.proposal.acceptanceId ?? ''}`);
    response.setHeader('ETag', `"${result.proposal.revision}"`);
    sendData(response, { proposal: serializeProposal(result.proposal), acceptance: { id: result.proposal.acceptanceId, revision: result.proposal.acceptedRevision }, execution: result.execution, replayed: result.replayed }, result.replayed ? 200 : 201);
  }));

  router.post(`${base}/:proposalId/execution`, sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, route(async (request, response) => {
    body(z.object({}).strict(), request.body ?? {});
    const conversationId = uuid(request.params.conversationId, new HomeConversationNotFoundError());
    const proposalId = uuid(request.params.proposalId, new HomeProposalNotFoundError());
    const result = await dependencies.proposals.execute({ ownerId: ownerId(request), conversationId, proposalId });
    sendData(response, { proposal: serializeProposal(result.proposal), execution: result.execution, replayed: result.replayed });
  }));

  router.post(`${base}/:proposalId/cancellation`, sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, route(async (request, response) => {
    const conversationId = uuid(request.params.conversationId, new HomeConversationNotFoundError());
    const proposalId = uuid(request.params.proposalId, new HomeProposalNotFoundError());
    const input = body(cancelBody, request.body);
    const proposal = await dependencies.proposals.cancel({ ownerId: ownerId(request), conversationId, proposalId, expectedRevision: input.expectedRevision });
    sendData(response, { proposal: serializeProposal(proposal) });
  }));

  return router;
}
