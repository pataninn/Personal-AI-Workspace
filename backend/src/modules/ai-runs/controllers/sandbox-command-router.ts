import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { SandboxCommandValidationError } from '@/modules/ai-runs/domain/command-errors';
import { GetSandboxCommandUseCase, ListSandboxCommandsUseCase, DecideSandboxCommandUseCase, CancelSandboxCommandUseCase, toCommandSnapshot } from '@/modules/ai-runs/use-cases/sandbox-command-use-cases';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const decisionSchema = z.object({
  proposalHash: z.string(),
  decision: z.enum(['approve', 'reject'])
}).strict();

const cancelSchema = z.object({}).strict();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface SandboxCommandRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly listCommands: ListSandboxCommandsUseCase;
  readonly getCommand: GetSandboxCommandUseCase;
  readonly decideCommand: DecideSandboxCommandUseCase;
  readonly cancelCommand: CancelSandboxCommandUseCase;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function parseUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new SandboxCommandValidationError([{ field: 'id', message: 'Route identifiers must be valid UUIDs.' }]);
  }
  return value;
}

function requiredIdempotencyKey(request: Parameters<RequestHandler>[0]): string {
  return request.header('idempotency-key') ?? '';
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The sandbox command request is invalid.', parsed.error.issues.map((issue) => ({ field: issue.path.join('.') || 'request', message: issue.message })));
  }
  return parsed.data;
}

function listHandler(dependencies: SandboxCommandRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const commands = await dependencies.listCommands.execute({ ownerId, runId: parseUuid(routeParam(request.params.runId)) });
      sendData(response, { commands: commands.map(toCommandSnapshot) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function getHandler(dependencies: SandboxCommandRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const command = await dependencies.getCommand.execute({ ownerId, runId: parseUuid(routeParam(request.params.runId)), commandId: parseUuid(routeParam(request.params.commandId)) });
      sendData(response, { command: toCommandSnapshot(command) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function decisionHandler(dependencies: SandboxCommandRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const body = parseBody(decisionSchema, request.body);
      const command = await dependencies.decideCommand.execute({ ownerId, runId: parseUuid(routeParam(request.params.runId)), commandId: parseUuid(routeParam(request.params.commandId)), proposalHash: body.proposalHash, decision: body.decision, idempotencyKey: requiredIdempotencyKey(request) });
      sendData(response, { command: toCommandSnapshot(command) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function cancelHandler(dependencies: SandboxCommandRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      parseBody(cancelSchema, request.body);
      const command = await dependencies.cancelCommand.execute({ ownerId, runId: parseUuid(routeParam(request.params.runId)), commandId: parseUuid(routeParam(request.params.commandId)), idempotencyKey: requiredIdempotencyKey(request) });
      sendData(response, { command: toCommandSnapshot(command) }, command.status === 'cancel_requested' ? 202 : 200);
    } catch (error: unknown) {
      next(error);
    }
  };
}

export function createSandboxCommandRouter(dependencies: SandboxCommandRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  router.get('/ai-runs/:runId/commands', authenticate, listHandler(dependencies));
  router.get('/ai-runs/:runId/commands/:commandId', authenticate, getHandler(dependencies));
  router.post('/ai-runs/:runId/commands/:commandId/decision', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, decisionHandler(dependencies));
  router.post('/ai-runs/:runId/commands/:commandId/cancel', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, cancelHandler(dependencies));
  return router;
}
