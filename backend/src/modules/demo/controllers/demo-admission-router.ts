import { timingSafeEqual } from 'node:crypto';
import type { CookieOptions, RequestHandler } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import { SESSION_COOKIE_NAME, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { DemoAdmissionAttemptResult } from '@/modules/demo/domain/demo-admission-types';
import type { DemoShowcaseCopyDto, IDemoShowcaseCopyManager } from '@/modules/demo/domain/demo-showcase-copy-types';
import { DemoAdmissionError, DemoAdmissionValidationError, DemoProvisioningFailedError } from '@/modules/demo/domain/demo-admission-errors';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const emptyRequestSchema = z.object({}).strict();

export interface DemoAdmissionRouterDependencies {
  readonly createSession: { execute(input: { readonly idempotencyKey: string; readonly clientIp: string | undefined }): Promise<DemoAdmissionAttemptResult> };
  readonly getSession: Pick<GetSessionUseCase, 'execute'>;
  readonly appOrigin: string;
  readonly cookieSecure: boolean;
  readonly showcaseCopy?: Pick<IDemoShowcaseCopyManager, 'getStatus' | 'retry'>;
}

function cookieOptions(secure: boolean, expiresAt?: Date, maxAge?: number): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    ...(maxAge !== undefined ? { maxAge } : {}),
    ...(expiresAt ? { expires: expiresAt } : {})
  };
}

function parseEmptyBody(body: unknown): void {
  const result = emptyRequestSchema.safeParse(body);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The demo admission request must be an empty object.');
  }
}

function csrfMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

function handler(dependencies: DemoAdmissionRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      parseEmptyBody(request.body);
      const rawToken = request.cookies?.[SESSION_COOKIE_NAME];
      if (typeof rawToken === 'string' && rawToken.length > 0) {
        try {
          const session = await dependencies.getSession.execute(rawToken);
          if (!csrfMatches(session.csrfToken, request.header('x-csrf-token'))) {
            throw new AppError('CSRF_INVALID', 403, 'The request could not be verified.');
          }
          if (session.principal.accountKind === 'regular') {
            throw new AppError('DEMO_REGULAR_SESSION_ACTIVE', 409, 'Sign out before opening a demo workspace.');
          }
          sendData(response, {
            state: 'ready' as const,
            principal: session.principal,
            csrfToken: session.csrfToken,
            expiresAt: session.expiresAt.toISOString()
          });
          return;
        } catch (error: unknown) {
          if (!(error instanceof UnauthenticatedError)) throw error;
        }
      }

      const key = request.header('idempotency-key');
      if (!key) throw new DemoAdmissionValidationError();
      const result = await dependencies.createSession.execute({ idempotencyKey: key, clientIp: request.ip });
      if (result.kind === 'created') {
        response.cookie(SESSION_COOKIE_NAME, result.session.rawToken, cookieOptions(dependencies.cookieSecure, result.session.expiresAt));
        sendData(response, {
          state: 'ready' as const,
          principal: result.session.principal,
          csrfToken: result.session.csrfToken,
          expiresAt: result.session.expiresAt.toISOString()
        }, 201);
        return;
      }
      if (result.state === 'failed') throw new DemoProvisioningFailedError();
      sendData(response, { state: result.state }, result.state === 'pending' ? 202 : 200);
    } catch (error: unknown) {
      next(mapDemoError(error));
    }
  };
}

function mapDemoError(error: unknown): unknown {
  if (error instanceof DemoAdmissionValidationError) {
    return new AppError(error.code, error.statusCode, error.message);
  }
  if (error instanceof DemoAdmissionError) {
    return new AppError(error.code, error.statusCode, error.message);
  }
  return error;
}

export function createDemoAdmissionRouter(dependencies: DemoAdmissionRouterDependencies): Router {
  const router = Router();
  router.post('/session', sameOrigin(dependencies.appOrigin), handler(dependencies));
  if (dependencies.showcaseCopy) {
    router.get('/showcase-copy', async (request, response, next): Promise<void> => {
      try {
        const token = request.cookies?.[SESSION_COOKIE_NAME];
        const session = await dependencies.getSession.execute(token);
        if (session.principal.accountKind !== 'demo') throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid demo session is required.');
        const result = await dependencies.showcaseCopy!.getStatus(session.principal.id);
        sendData(response, result, result.state === 'pending' ? 202 : 200);
      } catch (error: unknown) {
        next(mapDemoError(error));
      }
    });
    router.post('/showcase-copy/retries', sameOrigin(dependencies.appOrigin), async (request, response, next): Promise<void> => {
      try {
        parseEmptyBody(request.body);
        const token = request.cookies?.[SESSION_COOKIE_NAME];
        const session = await dependencies.getSession.execute(token);
        if (!csrfMatches(session.csrfToken, request.header('x-csrf-token'))) throw new AppError('CSRF_INVALID', 403, 'The request could not be verified.');
        if (session.principal.accountKind !== 'demo') throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid demo session is required.');
        const result: DemoShowcaseCopyDto = await dependencies.showcaseCopy!.retry(session.principal.id);
        sendData(response, result, result.state === 'pending' ? 202 : 200);
      } catch (error: unknown) {
        next(mapDemoError(error));
      }
    });
  }
  return router;
}
