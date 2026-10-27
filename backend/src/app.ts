import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { createHealthRouter, GetLivenessUseCase, GetReadinessUseCase } from '@/modules/health';
import { createAuthRouter, type AuthRouterDependencies } from '@/modules/auth';
import { createProjectRouter, type ProjectRouterDependencies } from '@/modules/projects';
import { createConversationRouter, type ConversationRouterDependencies } from '@/modules/conversations';
import { InvalidCredentialsError, SetupRequiredError, UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import { ProjectDomainError } from '@/modules/projects/domain/project-errors';
import { ConversationDomainError } from '@/modules/conversations/domain/conversation-errors';
import { WorkspaceDomainError } from '@/modules/files/domain/workspace-errors';
import { createWorkspaceRouter, type WorkspaceRouterDependencies } from '@/modules/files';
import { AppError, isAppError } from '@/shared/errors/app-error';
import type { AppLogger } from '@/shared/logging/logger';
import { sendError } from '@/shared/http/response';
import { AiRunDomainError } from '@/modules/ai-runs/domain/ai-run-errors';
import { createAiRunRouter, type AiRunRouterDependencies } from '@/modules/ai-runs';
import { createSandboxCommandRouter, type SandboxCommandRouterDependencies } from '@/modules/ai-runs/controllers/sandbox-command-router';
import { createAiRunChatRouter, type AiRunChatRouterDependencies } from '@/modules/ai-runs/controllers/ai-run-chat-router';
import { SandboxCommandDomainError } from '@/modules/ai-runs/domain/command-errors';
import { ChangeSetDomainError } from '@/modules/ai-runs/domain/change-errors';
import { ProjectFactDomainError } from '@/modules/memory/domain/project-fact-errors';
import { createProjectFactRouter, type ProjectFactRouterDependencies } from '@/modules/memory';
import { createGlobalTaskRouter, createProjectTaskRouter, ProjectTaskDomainError, type GlobalTaskRouterDependencies, type ProjectTaskRouterDependencies } from '@/modules/tasks';
import { createActionUndoRouter, type ActionUndoRouterDependencies } from '@/modules/home-assistant/controllers/action-undo-router';
import { createHomeConversationRouter, type HomeConversationRouterDependencies } from '@/modules/home-assistant/controllers/home-conversation-router';
import { createHomeProposalRouter, type HomeProposalRouterDependencies } from '@/modules/home-assistant/controllers/home-proposal-router';
import { HomeConversationDomainError } from '@/modules/home-assistant/domain/home-conversation-errors';
import { createAccountStorageRouter, type AccountStorageRouterDependencies } from '@/modules/storage-quotas/controllers/account-storage-router';
import { StorageQuotaError } from '@/modules/storage-quotas/domain/storage-quota-errors';
import { createDemoAdmissionRouter, type DemoAdmissionRouterDependencies } from '@/modules/demo/controllers/demo-admission-router';
import { DemoAdmissionError } from '@/modules/demo/domain/demo-admission-errors';
import { createAssistantExecutionPolicyRouter, type AssistantExecutionPolicyRouterDependencies } from '@/modules/assistant-policy/controllers/assistant-execution-policy-router';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { SESSION_COOKIE_NAME } from '@/modules/auth/controllers/request-auth';
import { createShowcaseRouter, type ShowcaseRouterDependencies } from '@/modules/showcases/controllers/showcase-router';
import { createSkillRouter, type SkillRouterDependencies } from '@/modules/skills';
import { createAdminPortalRouter, type AdminPortalRouterDependencies } from '@/modules/admin-portal';
import { createAutomationRouter, type AutomationRouterDependencies } from '@/modules/automations/controllers/automation-router';
import { createWorkspaceExportRouter, type WorkspaceExportRouterDependencies } from '@/modules/workspace-exports';

export interface CreateAppOptions {
  readonly logger: AppLogger;
  readonly readiness: GetReadinessUseCase;
  readonly appVersion: string;
  readonly staticDirectory?: string;
  readonly auth?: AuthRouterDependencies;
  readonly projects?: ProjectRouterDependencies;
  readonly conversations?: ConversationRouterDependencies;
  readonly workspace?: WorkspaceRouterDependencies;
  readonly aiRuns?: AiRunRouterDependencies;
  readonly sandboxCommands?: SandboxCommandRouterDependencies;
  readonly aiRunChat?: AiRunChatRouterDependencies;
  readonly projectFacts?: ProjectFactRouterDependencies;
  readonly projectTasks?: ProjectTaskRouterDependencies;
  readonly globalTasks?: GlobalTaskRouterDependencies;
  readonly actionUndo?: ActionUndoRouterDependencies;
  readonly homeConversations?: HomeConversationRouterDependencies;
  readonly homeProposals?: HomeProposalRouterDependencies;
  readonly accountStorage?: AccountStorageRouterDependencies;
  readonly demoAdmission?: DemoAdmissionRouterDependencies;
  readonly showcases?: ShowcaseRouterDependencies;
  readonly skills?: SkillRouterDependencies;
  readonly automations?: AutomationRouterDependencies;
  readonly adminPortal?: AdminPortalRouterDependencies;
  readonly workspaceExports?: WorkspaceExportRouterDependencies;
  readonly assistantExecutionPolicy?: AssistantExecutionPolicyRouterDependencies;
  readonly demoCopyGate?: { readonly getSession: Pick<GetSessionUseCase, 'execute'>; readonly isReady: (ownerId: string) => Promise<boolean> };
  readonly trustedProxyCidrs?: readonly string[];
}

const requestIdMiddleware: RequestHandler = (request, response, next) => {
  const requestId = request.header('x-request-id') ?? randomUUID();
  response.setHeader('x-request-id', requestId);
  next();
};

const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new AppError('NOT_FOUND', 404, 'The requested resource was not found.'));
};

const errorHandler = (logger: AppLogger): ErrorRequestHandler => (
  error: unknown,
  _request,
  response,
  next
) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  const appError = toAppError(error);
  if (appError) {
    sendError(response, appError.statusCode, {
      code: appError.code,
      message: appError.message,
      ...(appError.details.length > 0 ? { details: appError.details } : {})
    });
    return;
  }
  logger.error({ err: error }, 'Unhandled request error');
  sendError(response, 500, {
    code: 'INTERNAL_ERROR',
    message: 'Internal server error.'
  });
};

function toAppError(error: unknown): AppError | null {
  if (isAppError(error)) {
    return error;
  }
  if (error instanceof InvalidCredentialsError) {
    return new AppError('INVALID_CREDENTIALS', 401, 'The supplied local credentials were not accepted.');
  }
  if (error instanceof SetupRequiredError) {
    return new AppError('SETUP_REQUIRED', 503, 'Local setup is required before sign in is available.');
  }
  if (error instanceof UnauthenticatedError) {
    return new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
  }
  if (error instanceof ProjectDomainError) {
    return new AppError(error.code, error.statusCode, error.message, error.details);
  }
  if (error instanceof ConversationDomainError) {
    return new AppError(error.code, error.statusCode, error.message, error.details);
  }
  if (error instanceof WorkspaceDomainError) {
    return new AppError(error.code, error.statusCode, error.message, error.details);
  }
  if (error instanceof AiRunDomainError) {
    return new AppError(error.code, error.statusCode, error.message, error.details);
  }
  if (error instanceof SandboxCommandDomainError) {
    return new AppError(error.code, error.statusCode, error.message, error.details);
  }
  if (error instanceof ChangeSetDomainError) {
    return new AppError(error.code, error.statusCode, error.message, error.details);
  }
  if (error instanceof ProjectFactDomainError) {
    return new AppError(error.code, error.statusCode, error.message, error.details);
  }
  if (error instanceof ProjectTaskDomainError) {
    return new AppError(error.code, error.statusCode, error.message, error.details);
  }
  if (error instanceof HomeConversationDomainError) {
    return new AppError(error.code, error.statusCode, error.message);
  }
  if (error instanceof StorageQuotaError) {
    const details = Object.entries(error.details).map(([field, value]) => ({ field, message: String(value) }));
    return new AppError(error.code, error.statusCode, error.message, details);
  }
  if (error instanceof DemoAdmissionError) {
    return new AppError(error.code, error.statusCode, error.message);
  }
  if (isMalformedJsonError(error)) {
    return new AppError('VALIDATION_ERROR', 400, 'The request body is not valid JSON.');
  }
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') return new AppError('FILE_TOO_LARGE', 413, 'The request exceeds the allowed size.');
  return null;
}

function isMalformedJsonError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { status?: unknown; type?: unknown };
  return candidate.status === 400 && candidate.type === 'entity.parse.failed';
}

export function createApp(options: CreateAppOptions): Express {
  const app = express();
  const getLiveness = new GetLivenessUseCase();

  app.disable('x-powered-by');
  app.set('trust proxy', options.trustedProxyCidrs ?? false);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        frameSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"]
      }
    }
  }));
  app.use(requestIdMiddleware);
  app.use(pinoHttp({
    logger: options.logger,
    serializers: {
      req: (request) => ({ method: request.method }),
      res: (response) => ({ statusCode: response.statusCode })
    }
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  if (options.demoCopyGate) app.use(createDemoCopyGate(options.demoCopyGate));
  app.use(createHealthRouter({
    getLiveness,
    getReadiness: options.readiness,
    appVersion: options.appVersion
  }));
  if (options.auth) {
    app.use('/api/v1/auth', createAuthRouter(options.auth));
  }
  if (options.showcases) app.use('/api/v1', createShowcaseRouter(options.showcases));
  if (options.skills) app.use('/api/v1/skills', createSkillRouter(options.skills));
  if (options.automations) app.use('/api/v1/automations', createAutomationRouter(options.automations));
  if (options.adminPortal) app.use('/api/v1', createAdminPortalRouter(options.adminPortal));
  if (options.workspaceExports) app.use('/api/v1/workspace-exports', createWorkspaceExportRouter(options.workspaceExports));
  if (options.demoAdmission) {
    app.use('/api/v1/demo', createDemoAdmissionRouter(options.demoAdmission));
  }
  if (options.projects) {
    app.use('/api/v1/projects', createProjectRouter(options.projects));
  }
  if (options.conversations) {
    app.use('/api/v1', createConversationRouter(options.conversations));
  }
  if (options.homeConversations) {
    app.use('/api/v1', createHomeConversationRouter(options.homeConversations));
  }
  if (options.homeProposals) {
    app.use('/api/v1', createHomeProposalRouter(options.homeProposals));
  }
  if (options.accountStorage) {
    app.use('/api/v1', createAccountStorageRouter(options.accountStorage));
  }
  if (options.assistantExecutionPolicy) {
    app.use('/api/v1', createAssistantExecutionPolicyRouter(options.assistantExecutionPolicy));
  }
  if (options.workspace) {
    app.use('/api/v1/projects/:projectId/files', createWorkspaceRouter(options.workspace));
  }
  if (options.aiRuns) {
    app.use('/api/v1', createAiRunRouter(options.aiRuns));
  }
  if (options.sandboxCommands) {
    app.use('/api/v1', createSandboxCommandRouter(options.sandboxCommands));
  }
  if (options.aiRunChat) {
    app.use('/api/v1', createAiRunChatRouter(options.aiRunChat));
  }
  if (options.projectFacts) {
    app.use('/api/v1/projects/:projectId/facts', createProjectFactRouter(options.projectFacts));
  }
  if (options.projectTasks) {
    app.use('/api/v1/projects/:projectId', createProjectTaskRouter(options.projectTasks));
  }
  if (options.globalTasks) {
    app.use('/api/v1', createGlobalTaskRouter(options.globalTasks));
  }
  if (options.actionUndo) {
    app.use('/api/v1/actions', createActionUndoRouter(options.actionUndo));
  }

  if (options.staticDirectory && existsSync(options.staticDirectory)) {
    const staticDirectory = path.resolve(options.staticDirectory);
    app.use(express.static(staticDirectory, { dotfiles: 'deny', index: 'index.html' }));
    app.get(/^\/(?!api\/|health$|ready$).*/, (_request, response) => {
      response.sendFile(path.join(staticDirectory, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler(options.logger));
  return app;
}

function createDemoCopyGate(dependencies: NonNullable<CreateAppOptions['demoCopyGate']>): RequestHandler {
  const allowed = new Set([
    'GET /api/v1/auth/session',
    'POST /api/v1/auth/logout',
    'POST /api/v1/demo/session',
    'GET /api/v1/demo/showcase-copy',
    'POST /api/v1/demo/showcase-copy/retries',
    'GET /api/v1/demo/availability',
    'GET /api/v1/showcases/current'
  ]);
  return async (request, _response, next): Promise<void> => {
    if (!request.path.startsWith('/api/v1/')) { next(); return; }
    const route = `${request.method.toUpperCase()} ${request.path}`;
    if (allowed.has(route) || (request.method === 'GET' && /^\/api\/v1\/showcases\/current\/files\/[0-9a-f-]+$/iu.test(request.path))) {
      next();
      return;
    }
    const rawToken = request.cookies?.[SESSION_COOKIE_NAME];
    if (typeof rawToken !== 'string') { next(); return; }
    try {
      const session = await dependencies.getSession.execute(rawToken);
      if (session.principal.accountKind !== 'demo') { next(); return; }
      if (!(await dependencies.isReady(session.principal.id))) {
        next(new AppError('DEMO_COPY_NOT_READY', 409, 'The private demo workspace is still being prepared.'));
        return;
      }
      next();
    } catch (error: unknown) {
      if (error instanceof UnauthenticatedError) { next(); return; }
      next(new AppError('DEMO_COPY_UNAVAILABLE', 503, 'The private demo workspace is unavailable.'));
    }
  };
}
