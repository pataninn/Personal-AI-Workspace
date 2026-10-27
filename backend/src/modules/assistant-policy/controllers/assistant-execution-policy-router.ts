import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequest } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import type { GetAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/get-assistant-execution-policy';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const querySchema = z.object({
  scope: z.enum(['home', 'workspace']),
  projectId: z.guid().optional()
}).strict().superRefine((query, context) => {
  if (query.scope === 'home' && query.projectId !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectId'], message: 'Home scope does not accept a project.' });
  }
  if (query.scope === 'workspace' && query.projectId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['projectId'], message: 'Select a workspace.' });
  }
});

export interface AssistantExecutionPolicyRouterDependencies {
  readonly getExecutionPolicy: GetAssistantExecutionPolicyUseCase;
  readonly getSession: GetSessionUseCase;
  readonly clearSessionCookie: (response: Response) => void;
}

function ownerId(request: Request): string {
  const id = request.auth?.principal.id;
  if (!id) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
  return id;
}

function policyHandler(dependencies: AssistantExecutionPolicyRouterDependencies): RequestHandler {
  return (request, response, next): void => {
    void (async (): Promise<void> => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', 400, 'The assistant policy query is invalid.', parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || 'query',
          message: issue.message
        })));
      }
      const id = ownerId(request);
      const scope = parsed.data.scope === 'home'
        ? { ownerId: id, scopeKind: 'home' as const, projectId: null }
        : { ownerId: id, scopeKind: 'project' as const, projectId: parsed.data.projectId as string };
      sendData(response, await dependencies.getExecutionPolicy.execute(scope));
    })().catch(next);
  };
}

export function createAssistantExecutionPolicyRouter(dependencies: AssistantExecutionPolicyRouterDependencies): Router {
  const router = Router();
  router.get('/assistant/execution-policy',
    authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie),
    policyHandler(dependencies));
  return router;
}
