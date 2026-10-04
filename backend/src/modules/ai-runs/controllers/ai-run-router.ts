import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { AiRunManifestConflictError, AiRunNotFoundError, AiRunProviderPermissionRevokedError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { AiRun, EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';
import type { ProviderPermission } from '@/modules/ai-runs/domain/provider-permission';
import { CreateAiRunUseCase, DecideEgressUseCase, GetAiRunUseCase } from '@/modules/ai-runs/use-cases/ai-run-use-cases';
import { ListProviderPermissionsUseCase, RevokeProviderPermissionUseCase } from '@/modules/ai-runs/use-cases/provider-permission-use-cases';
import { DecideProposedChangeSetUseCase, GetProposedChangeSetUseCase } from '@/modules/ai-runs/use-cases/change-set-use-cases';
import type { ProposedChangeSet } from '@/modules/ai-runs/domain/change-types';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';
import type { SendChatMessageUseCase } from '@/modules/ai-runs/use-cases/send-chat-message-use-case';
import type { ProjectChatContextUseCases } from '@/modules/ai-runs/use-cases/project-chat-context-use-cases';
import type { ProjectTaskSuggestion } from '@/modules/tasks/domain/project-task';
import type { IProjectTaskSuggestionQuery } from '@/modules/tasks/repositories/task-suggestion-query';
import type { GetAiRunActivityUseCase, ListAiRunActivityUseCase } from '@/modules/ai-runs/use-cases/activity-use-cases';
import type { ListProjectFileHistoryUseCase } from '@/modules/ai-runs/use-cases/file-history-use-cases';

const createRunSchema = z.object({
  conversationId: z.string(),
  request: z.string(),
  context: z.object({
    factIds: z.array(z.string()).optional(),
    relativePaths: z.array(z.string()).optional(),
    includeRecentMessages: z.boolean().optional()
  }).strict().optional()
}).strict();

const decisionSchema = z.object({
  manifestHash: z.string(),
  decision: z.enum(['approve', 'reject']),
  rememberProviderPermission: z.boolean().optional()
}).strict();

const changeSetDecisionSchema = z.object({
  proposalHash: z.string().min(1),
  decision: z.enum(['approve', 'reject'])
}).strict();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const chatContextSchema = z.object({ relativePaths: z.array(z.string()).optional(), excludedPaths: z.array(z.string()).max(1000).optional(), factIds: z.array(z.string().uuid()).optional(), includeProjectConversations: z.boolean().optional() }).strict();
const chatMessageSchema = z.object({ conversationId: z.string().uuid(), request: z.string() }).strict();

export interface AiRunRouterDependencies {
  readonly sendChatMessage?: SendChatMessageUseCase;
  readonly projectChatContext?: ProjectChatContextUseCases;
  readonly getSession: GetSessionUseCase;
  readonly createAiRun: CreateAiRunUseCase;
  readonly getAiRun: GetAiRunUseCase;
  readonly decideEgress: DecideEgressUseCase;
  readonly getProposedChangeSet?: GetProposedChangeSetUseCase;
  readonly decideProposedChangeSet?: DecideProposedChangeSetUseCase;
  readonly taskSuggestionsForRun?: IProjectTaskSuggestionQuery;
  readonly listActivity?: ListAiRunActivityUseCase;
  readonly getActivity?: GetAiRunActivityUseCase;
  readonly listFileHistory?: ListProjectFileHistoryUseCase;
  readonly listProviderPermissions?: ListProviderPermissionsUseCase;
  readonly revokeProviderPermission?: RevokeProviderPermissionUseCase;
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

function queryValue(value: unknown): unknown {
  return typeof value === 'string' ? value : value === undefined ? undefined : '';
}

function listActivityHandler(dependencies: AiRunRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId || !dependencies.listActivity) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projectId = parseUuid(routeParam(request.params.projectId), new AiRunNotFoundError());
      const result = await dependencies.listActivity.execute({
        ownerId,
        projectId,
        limit: queryValue(request.query.limit),
        cursor: queryValue(request.query.cursor),
        filter: queryValue(request.query.filter)
      });
      sendData(response, result);
    } catch (error: unknown) {
      next(error);
    }
  };
}

function activityDetailHandler(dependencies: AiRunRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId || !dependencies.getActivity) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const runId = parseUuid(routeParam(request.params.runId), new AiRunNotFoundError());
      sendData(response, await dependencies.getActivity.execute({ ownerId, runId }));
    } catch (error: unknown) {
      next(error);
    }
  };
}

function fileHistoryHandler(dependencies: AiRunRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId || !dependencies.listFileHistory) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projectId = parseUuid(routeParam(request.params.projectId), new AiRunNotFoundError());
      sendData(response, await dependencies.listFileHistory.execute({
        ownerId,
        projectId,
        path: queryValue(request.query.path),
        outcome: queryValue(request.query.outcome),
        limit: queryValue(request.query.limit),
        cursor: queryValue(request.query.cursor)
      }));
    } catch (error: unknown) {
      next(error);
    }
  };
}

function providerPermissionsHandler(dependencies: AiRunRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId || !dependencies.listProviderPermissions) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projectId = parseUuid(routeParam(request.params.projectId), new AiRunNotFoundError());
      const permissions = await dependencies.listProviderPermissions.execute({ ownerId, projectId });
      sendData(response, { permissions: permissions.map(serializeProviderPermission) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function revokeProviderPermissionHandler(dependencies: AiRunRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId || !dependencies.revokeProviderPermission) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const projectId = parseUuid(routeParam(request.params.projectId), new AiRunNotFoundError());
      const permissionId = parseUuid(routeParam(request.params.permissionId), new AiRunNotFoundError());
      const permission = await dependencies.revokeProviderPermission.execute({ ownerId, projectId, permissionId });
      sendData(response, { permission: serializeProviderPermission(permission) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function requiredIdempotencyKey(request: Parameters<RequestHandler>[0]): string {
  return request.header('idempotency-key') ?? '';
}

function chatContextHandler(dependencies: AiRunRouterDependencies, update: boolean): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId || !dependencies.projectChatContext) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
      const projectId = parseUuid(routeParam(request.params.projectId), new AiRunNotFoundError());
      const changes = update ? parseBody(chatContextSchema, request.body) : {};
      const context = update ? await dependencies.projectChatContext.update(ownerId, projectId, {
        ...(changes.relativePaths === undefined ? {} : { relativePaths: changes.relativePaths }),
        ...(changes.excludedPaths === undefined ? {} : { excludedPaths: changes.excludedPaths }),
        ...(changes.factIds === undefined ? {} : { factIds: changes.factIds }),
        ...(changes.includeProjectConversations === undefined ? {} : { includeProjectConversations: changes.includeProjectConversations })
      })
        : await dependencies.projectChatContext.get(ownerId, projectId);
      sendData(response, context);
    } catch (error: unknown) { next(error); }
  };
}

function sendChatHandler(dependencies: AiRunRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId || !dependencies.sendChatMessage) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
      const body = parseBody(chatMessageSchema, request.body);
      const result = await dependencies.sendChatMessage.execute({ ownerId,
        projectId: parseUuid(routeParam(request.params.projectId), new AiRunNotFoundError()), ...body,
        idempotencyKey: requiredIdempotencyKey(request) });
      response.location(`/api/v1/ai-runs/${result.resource.id}`);
      sendData(response, { run: serializeSnapshot(result.resource), manifest: serializeManifest(result.resource) }, result.replayed ? 200 : 202);
    } catch (error: unknown) { next(error); }
  };
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
        factIds: body.context?.factIds,
        relativePaths: body.context?.relativePaths,
        includeRecentMessages: body.context?.includeRecentMessages ?? false,
        idempotencyKey: requiredIdempotencyKey(request)
      });
      let run = result.resource;
      try {
        run = await dependencies.decideEgress.approveWithRememberedPermission({ ownerId, runId: run.id }) ?? run;
      } catch (error: unknown) {
        if (!(error instanceof AiRunProviderPermissionRevokedError)) throw error;
      }
      response.location(`/api/v1/ai-runs/${run.id}`);
      sendData(response, {
        run: serializeSnapshot(run),
        manifest: serializeManifest(run)
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
      const taskSuggestions = dependencies.taskSuggestionsForRun
        ? await dependencies.taskSuggestionsForRun.listForRun(ownerId, run.projectId, run.id)
        : [];
      sendData(response, { ...serializeSnapshot(run), taskSuggestions: taskSuggestions.map(serializeTaskSuggestion) });
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
        rememberProviderPermission: body.rememberProviderPermission ?? false,
        idempotencyKey: requiredIdempotencyKey(request)
      });
      sendData(response, { run: serializeSnapshot(run), manifest: serializeManifest(run) });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function proposedChangeSetHandler(dependencies: AiRunRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      if (!dependencies.getProposedChangeSet) {
        next(new AppError('NOT_FOUND', 404, 'The proposed change set is not available.'));
        return;
      }
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const runId = parseUuid(routeParam(request.params.runId), new AiRunNotFoundError());
      const changeSet = await dependencies.getProposedChangeSet.execute({ ownerId, runId });
      sendData(response, serializeProposedChangeSet(changeSet));
    } catch (error: unknown) {
      next(error);
    }
  };
}

function proposedChangeDecisionHandler(dependencies: AiRunRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      if (!dependencies.decideProposedChangeSet) {
        next(new AppError('NOT_FOUND', 404, 'The proposed change set is not available.'));
        return;
      }
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const runId = parseUuid(routeParam(request.params.runId), new AiRunNotFoundError());
      const body = parseBody(changeSetDecisionSchema, request.body);
      const changeSet = await dependencies.decideProposedChangeSet.execute({
        ownerId,
        runId,
        proposalHash: body.proposalHash,
        decision: body.decision,
        idempotencyKey: requiredIdempotencyKey(request)
      });
      sendData(response, serializeProposedChangeSet(changeSet));
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
    ...(run.assistantComplete !== undefined || run.assistantContentLength !== undefined ? {
      assistant: {
        ...(run.assistantMessageId ? { messageId: run.assistantMessageId } : {}),
        complete: run.assistantComplete ?? false,
        contentLength: run.assistantContentLength ?? 0
      }
    } : {}),
    ...(run.runtimeKind && run.sandboxReady ? { runtime: { kind: run.runtimeKind, sandboxReady: true } } : {}),
    ...(run.decision === 'approved' ? { providerApprovalMode: run.providerPermissionId ? 'remembered_permission' : 'one_time' } : {})
  };
}

function serializeProviderPermission(permission: ProviderPermission): Record<string, unknown> {
  return {
    id: permission.id,
    subject: { ownerId: permission.ownerId, label: 'Signed-in account' },
    projectId: permission.projectId,
    providerProfile: permission.providerProfile,
    model: permission.model,
    capability: permission.capability,
    persistence: 'until_revoked',
    expiresAt: null,
    createdAt: permission.createdAt.toISOString(),
    revokedAt: permission.revokedAt?.toISOString() ?? null
  };
}

function serializeTaskSuggestion(suggestion: ProjectTaskSuggestion): Record<string, unknown> {
  return {
    id: suggestion.id,
    projectId: suggestion.projectId,
    runId: suggestion.runId,
    conversationId: suggestion.conversationId,
    title: suggestion.title,
    details: suggestion.details,
    status: suggestion.status,
    version: suggestion.version,
    taskId: suggestion.taskId,
    source: suggestion.source,
    createdAt: suggestion.createdAt.toISOString(),
    resolvedAt: suggestion.resolvedAt?.toISOString() ?? null
  };
}

function serializeManifest(run: AiRun): Record<string, unknown> {
  const manifest: EgressManifest = run.manifest;
  const facts = manifest.facts ?? [];
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
      factCount: facts.length,
      facts,
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
    ...(manifest.files.length === 0 && manifest.messageCount === 0 && facts.length === 0 ? { emptyContextNotice: 'No project files or facts are selected. Only your request will be sent if you approve.' } : {})
  };
}

function consentNotice(run: AiRun): string {
  if (run.decision === 'pending') {
    return `Nothing has been copied to the run staging area or sent to ${run.manifest.provider} yet.`;
  }
  if (run.status === 'review_required' || run.providerTransmission === 'unknown') {
    return 'Provider transmission status is unknown. Refresh the run status before retrying.';
  }
  if (run.decision === 'rejected') {
    return `Nothing was copied to the run staging area or sent to ${run.manifest.provider}.`;
  }
  return 'This disclosure was approved for this run.';
}

function serializeProposedChangeSet(changeSet: ProposedChangeSet): Record<string, unknown> {
  return {
    runId: changeSet.runId,
    projectId: changeSet.projectId,
    status: changeSet.status,
    decision: changeSet.decision,
    proposalHash: changeSet.proposalHash,
    fakeRuntime: changeSet.fakeRuntime,
    runtimeProvenance: changeSet.fakeRuntime ? 'fake_runtime_development_preview' : 'unverified_runtime',
    counts: changeSet.counts,
    totalSizeBytes: changeSet.totalSizeBytes,
    totalLineCount: changeSet.totalLineCount,
    previewLimitBytes: changeSet.previewLimitBytes,
    previewLimitLines: changeSet.previewLimitLines,
    safeMessage: changeSet.safeMessage,
    operations: changeSet.operations.map((operation) => ({
      operationId: operation.operationId,
      operation: operation.operation,
      path: operation.path,
      ...(operation.destinationPath ? { destinationPath: operation.destinationPath } : {}),
      summary: operation.summary,
      ...(operation.expectedSourceHash ? { expectedSourceHash: operation.expectedSourceHash } : {}),
      ...(operation.expectedDestinationHash ? { expectedDestinationHash: operation.expectedDestinationHash } : {}),
      sourcePresent: operation.sourcePresent,
      destinationPresent: operation.destinationPresent,
      backupRequired: operation.backupRequired,
      sizeBytes: operation.sizeBytes,
      lineCount: operation.lineCount,
      reviewable: operation.reviewable,
      ...(operation.preview ? { preview: operation.preview } : {})
    })),
    ...(changeSet.result ? {
      result: {
        persisted: true,
        appliedCount: changeSet.result.appliedCount,
        skippedCount: changeSet.result.skippedCount,
        failedCount: changeSet.result.failedCount,
        backupCount: changeSet.result.backupCount,
        ...(changeSet.result.conflictPath ? { conflictPath: changeSet.result.conflictPath } : {}),
        operations: changeSet.result.operations.map((operation) => ({
          operationId: operation.operationId,
          operation: operation.operation,
          path: operation.path,
          ...(operation.destinationPath ? { destinationPath: operation.destinationPath } : {}),
          status: operation.status,
          backup: operation.backup,
          safeMessage: operation.safeMessage
        }))
      }
    } : {}),
    createdAt: changeSet.createdAt.toISOString(),
    updatedAt: changeSet.updatedAt.toISOString()
  };
}

export function createAiRunRouter(dependencies: AiRunRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  if (dependencies.projectChatContext) {
    router.get('/projects/:projectId/chat-context', authenticate, chatContextHandler(dependencies, false));
    router.patch('/projects/:projectId/chat-context', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, chatContextHandler(dependencies, true));
  }
  if (dependencies.sendChatMessage) {
    router.post('/projects/:projectId/chat-runs', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, sendChatHandler(dependencies));
  }
  if (dependencies.listActivity) {
    router.get('/projects/:projectId/ai-runs', authenticate, listActivityHandler(dependencies));
  }
  if (dependencies.getActivity) {
    router.get('/ai-runs/:runId/activity', authenticate, activityDetailHandler(dependencies));
  }
  if (dependencies.listFileHistory) {
    router.get('/projects/:projectId/file-history', authenticate, fileHistoryHandler(dependencies));
  }
  if (dependencies.listProviderPermissions && dependencies.revokeProviderPermission) {
    router.get('/projects/:projectId/provider-permissions', authenticate, providerPermissionsHandler(dependencies));
    router.delete('/projects/:projectId/provider-permissions/:permissionId', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, revokeProviderPermissionHandler(dependencies));
  }
  router.post('/projects/:projectId/ai-runs', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, createHandler(dependencies));
  router.get('/ai-runs/:runId', authenticate, getHandler(dependencies));
  router.get('/ai-runs/:runId/egress-manifest', authenticate, manifestHandler(dependencies));
  router.post('/ai-runs/:runId/egress-decision', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, decisionHandler(dependencies));
  if (dependencies.getProposedChangeSet && dependencies.decideProposedChangeSet) {
    router.get('/ai-runs/:runId/proposed-change-set', authenticate, proposedChangeSetHandler(dependencies));
    router.post('/ai-runs/:runId/proposed-change-set/decision', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, proposedChangeDecisionHandler(dependencies));
  }
  return router;
}
