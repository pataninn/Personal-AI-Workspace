import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { AiRunManifestConflictError, AiRunNotFoundError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { AiRun, EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import { CreateAiRunUseCase, DecideEgressUseCase, GetAiRunUseCase } from '@/modules/ai-runs/use-cases/ai-run-use-cases';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const createRunSchema = z.object({
  conversationId: z.string(),
  request: z.string(),
  context: z.object({
    relativePaths: z.array(z.string()).optional(),
    includeRecentMessages: z.boolean().optional()
  }).strict().optional()
}).strict();

const decisionSchema = z.object({
  manifestHash: z.string(),
  decision: z.enum(['approve', 'reject'])
}).strict();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AiRunRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly createAiRun: CreateAiRunUseCase;
  readonly getAiRun: GetAiRunUseCase;
  readonly decideEgress: DecideEgressUseCase;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The AI run request is invalid.', result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request',
      message: issue.message
    })));
  }
  return result.data;
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function parseUuid(value: string, error: Error): string {
  if (!UUID_PATTERN.test(value)) {
    throw error;
  }
  return value;
}

function requiredIdempotencyKey(request: Parameters<RequestHandler>[0]): string {
  return request.header('idempotency-key') ?? '';
}

function createHandler(dependencies: AiRunRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projectId = parseUuid(routeParam(request.params.projectId), new AiRunNotFoundError());
      const body = parseBody(createRunSchema, request.body);
      const result = await dependencies.createAiRun.execute({
        ownerId,
        projectId,
        conversationId: parseUuid(body.conversationId, new AiRunNotFoundError()),
        request: body.request,
        relativePaths: body.context?.relativePaths,
        includeRecentMessages: body.context?.includeRecentMessages ?? false,
        idempotencyKey: requiredIdempotencyKey(request)
      });
      response.location(`/api/v1/ai-runs/${result.resource.id}`);
      sendData(response, {
        run: serializeSnapshot(result.resource),
        manifest: serializeManifest(result.resource)
      }, result.replayed ? 200 : 202);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function getHandler(dependencies: AiRunRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const runId = parseUuid(routeParam(request.params.runId), new AiRunNotFoundError());
      const run = await dependencies.getAiRun.execute({ ownerId, runId });
      sendData(response, serializeSnapshot(run));
    } catch (error: unknown) {
      next(error);
    }
  };
}

function manifestHandler(dependencies: AiRunRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const runId = parseUuid(routeParam(request.params.runId), new AiRunNotFoundError());
      const run = await dependencies.getAiRun.execute({ ownerId, runId });
      if (run.manifestInvalidated) {
        next(new AiRunManifestConflictError());
        return;
      }
      sendData(response, serializeManifest(run));
    } catch (error: unknown) {
      next(error);
    }
  };
}

function decisionHandler(dependencies: AiRunRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const runId = parseUuid(routeParam(request.params.runId), new AiRunNotFoundError());
      const body = parseBody(decisionSchema, request.body);
      const run = await dependencies.decideEgress.execute({
        ownerId,
        runId,
        manifestHash: body.manifestHash,
        decision: body.decision,
        idempotencyKey: requiredIdempotencyKey(request)
      });
      sendData(response, { run: serializeSnapshot(run), manifest: serializeManifest(run) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function serializeSnapshot(run: AiRun): Record<string, unknown> {
  return {
    runId: run.id,
    projectId: run.projectId,
    conversationId: run.conversationId,
    status: run.status,
    phase: run.phase,
    manifestHash: run.manifest.manifestHash,
    decision: run.decision,
    safeMessage: run.safeMessage,
    cleanup: run.cleanup,
    providerTransmission: run.providerTransmission,
    stagingItemCount: run.stagingItemCount,
    ...(run.runtimeKind && run.sandboxReady ? { runtime: { kind: run.runtimeKind, sandboxReady: true } } : {})
  };
}

function serializeManifest(run: AiRun): Record<string, unknown> {
  const manifest: EgressManifest = run.manifest;
  return {
    runId: run.id,
    manifestHash: manifest.manifestHash,
    status: run.decision === 'pending' ? 'pending_approval' : run.status,
    provider: manifest.provider,
    providerProfile: manifest.providerProfile,
    model: manifest.model,
    content: {
      categories: manifest.categories,
      relativePaths: manifest.files.map((file) => file.relativePath),
      itemCount: manifest.files.length,
      byteEstimate: manifest.byteEstimate,
      tokenEstimate: manifest.tokenEstimate,
      messageCount: manifest.messageCount
    },
    redaction: {
      excludedItemCount: manifest.excludedItemCount,
      omittedItemCount: manifest.omittedItemCount,
      summary: manifest.omissionSummary
    },
    bestEffortSecretDetection: manifest.bestEffortSecretDetection,
    preConsentNotice: consentNotice(run),
    ...(manifest.files.length === 0 && manifest.messageCount === 0 ? { emptyContextNotice: 'No project files or facts are selected. Only your request will be sent if you approve.' } : {})
  };
}

function consentNotice(run: AiRun): string {
  if (run.decision === 'pending') {
    return 'Nothing has been copied to the run staging area or sent to NVIDIA yet.';
  }
  if (run.status === 'review_required' || run.providerTransmission === 'unknown') {
    return 'Provider transmission status is unknown. Refresh the run status before retrying.';
  }
  if (run.decision === 'rejected') {
    return 'Nothing was copied to the run staging area or sent to NVIDIA.';
  }
  return 'This disclosure was approved for this run.';
}

export function createAiRunRouter(dependencies: AiRunRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  router.post('/projects/:projectId/ai-runs', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, createHandler(dependencies));
  router.get('/ai-runs/:runId', authenticate, getHandler(dependencies));
  router.get('/ai-runs/:runId/egress-manifest', authenticate, manifestHandler(dependencies));
  router.post('/ai-runs/:runId/egress-decision', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, decisionHandler(dependencies));
  return router;
}
