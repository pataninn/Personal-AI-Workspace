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
import { createProjectTaskRouter, ProjectTaskDomainError, type ProjectTaskRouterDependencies } from '@/modules/tasks';

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
  app.use(pinoHttp({ logger: options.logger }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(createHealthRouter({
    getLiveness,
    getReadiness: options.readiness,
    appVersion: options.appVersion
  }));
  if (options.auth) {
    app.use('/api/v1/auth', createAuthRouter(options.auth));
  }
  if (options.projects) {
    app.use('/api/v1/projects', createProjectRouter(options.projects));
  }
  if (options.conversations) {
    app.use('/api/v1', createConversationRouter(options.conversations));
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
