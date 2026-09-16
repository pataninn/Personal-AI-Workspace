import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import type { IRunEventPublisher, RunEvent } from '@/modules/ai-runs/repositories/run-event-publisher';
import { CancelAiRunUseCase } from '@/modules/ai-runs/use-cases/cancel-ai-run-use-case';
import { GetAiRunUseCase, toSnapshot } from '@/modules/ai-runs/use-cases/ai-run-use-cases';
import { StartAiRunUseCase } from '@/modules/ai-runs/use-cases/start-ai-run-use-case';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const emptyBodySchema = z.object({}).strict();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AiRunChatRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly getAiRun: GetAiRunUseCase;
  readonly startAiRun: StartAiRunUseCase;
  readonly cancelAiRun: CancelAiRunUseCase;
  readonly events: IRunEventPublisher;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function runId(request: Parameters<RequestHandler>[0]): string {
  const value = routeParam(request.params.runId);
  if (!UUID_PATTERN.test(value)) {
    throw new AppError('VALIDATION_ERROR', 400, 'The AI run identifier is invalid.');
  }
  return value;
}

function idempotencyKey(request: Parameters<RequestHandler>[0]): string {
  return request.header('idempotency-key') ?? '';
}

function parseEmptyBody(body: unknown): void {
  const parsed = emptyBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The AI run request is invalid.');
  }
}

function startHandler(dependencies: AiRunChatRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      parseEmptyBody(request.body);
      const result = await dependencies.startAiRun.execute({ ownerId, runId: runId(request), idempotencyKey: idempotencyKey(request) });
      sendData(response, { run: serializeSnapshot(result.resource) }, result.replayed ? 200 : 202);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function cancelHandler(dependencies: AiRunChatRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      parseEmptyBody(request.body);
      const result = await dependencies.cancelAiRun.execute({ ownerId, runId: runId(request), idempotencyKey: idempotencyKey(request) });
      sendData(response, { run: serializeSnapshot(result) }, result.status === 'cancel_requested' ? 202 : 200);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function eventsHandler(dependencies: AiRunChatRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    let closed = request.destroyed;
    let unsubscribe = (): void => undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      unsubscribe();
      unsubscribe = (): void => undefined;
    };
    request.on('close', cleanup);
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const identifier = runId(request);
      const run = await dependencies.getAiRun.execute({ ownerId, runId: identifier });
      if (closed) {
        return;
      }
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders();
      heartbeat = setInterval(() => {
        if (!closed) {
          response.write(': heartbeat\n\n');
        }
      }, 15_000);
      const subscription = dependencies.events.subscribe(identifier, (event) => {
        if (closed) {
          return;
        }
        writeEvent(response, event);
        if (isTerminalEvent(event.type)) {
          cleanup();
          response.end();
        }
      });
      unsubscribe = subscription;
      if (closed) {
        unsubscribe();
        unsubscribe = (): void => undefined;
        return;
      }
      writeEvent(response, {
        runId: identifier,
        type: 'run.snapshot',
        sequence: 0,
        occurredAt: new Date(),
        payload: serializeSnapshot(run)
      });
      if (isTerminalStatus(run.status)) {
        cleanup();
        response.end();
      }
    } catch (error: unknown) {
      if (closed) {
        return;
      }
      next(error);
    }
  };
}

function writeEvent(response: Response, event: RunEvent): void {
  const payload = boundedPayload(event.payload);
  response.write(`event: ${event.type}\n`);
  response.write(`id: ${event.sequence}\n`);
  response.write(`data: ${JSON.stringify({ runId: event.runId, type: event.type, sequence: event.sequence, occurredAt: event.occurredAt.toISOString(), payload })}\n\n`);
}

function boundedPayload(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, 'utf8') <= 32 * 1024) {
    return payload;
  }
  return { status: 'review_required', safeMessage: 'The event was too large to display safely. Refresh run status.' };
}

function serializeSnapshot(run: Awaited<ReturnType<GetAiRunUseCase['execute']>>): Record<string, unknown> {
  return { ...toSnapshot(run) };
}

function isTerminalStatus(status: string): boolean {
  return ['succeeded', 'failed', 'blocked', 'cancelled', 'review_required', 'rejected'].includes(status);
}

function isTerminalEvent(type: RunEvent['type']): boolean {
  return type === 'run.completed' || type === 'run.failed' || type === 'run.blocked' || type === 'run.cancelled' || type === 'run.needs_manual_review';
}

export function createAiRunChatRouter(dependencies: AiRunChatRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  router.post('/ai-runs/:runId/start', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, startHandler(dependencies));
  router.post('/ai-runs/:runId/cancel', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, cancelHandler(dependencies));
  router.get('/ai-runs/:runId/events', authenticate, eventsHandler(dependencies));
  return router;
}
