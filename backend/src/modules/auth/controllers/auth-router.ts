import type { CookieOptions, RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import type { LoginUseCase } from '@/modules/auth/use-cases/login';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import type { LogoutUseCase } from '@/modules/auth/use-cases/logout';
import {
  authenticateRequest,
  requireCsrf,
  sameOrigin,
  SESSION_COOKIE_NAME
} from '@/modules/auth/controllers/request-auth';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';
import type { ILoginRateLimiter } from '@/modules/auth/repositories/security-providers';

const loginSchema = z.object({
  password: z.string().max(1024).refine((value) => value.trim().length > 0, {
    message: 'Password must contain at least one non-whitespace character.'
  })
}).strict();

export interface AuthRouterDependencies {
  readonly login: LoginUseCase;
  readonly getSession: GetSessionUseCase;
  readonly logout: LogoutUseCase;
  readonly appOrigin: string;
  readonly cookieSecure: boolean;
  readonly sessionLifetimeMs: number;
  readonly rateLimiter: ILoginRateLimiter;
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

export function clearSessionCookie(response: Response, secure: boolean): void {
  response.cookie(SESSION_COOKIE_NAME, '', cookieOptions(secure, undefined, 0));
}

function parseLoginBody(body: unknown): { password: string } {
  const result = loginSchema.safeParse(body);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The sign-in request is invalid.', result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'password',
      message: issue.message
    })));
  }
  return result.data;
}

function loginHandler(dependencies: AuthRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    if (!dependencies.rateLimiter.consume(request.ip ?? 'unknown')) {
      next(new AppError('AUTH_RATE_LIMITED', 429, 'Too many attempts. Wait a moment, then try again.'));
      return;
    }
    try {
      const result = await dependencies.login.execute(parseLoginBody(request.body));
      response.cookie(
        SESSION_COOKIE_NAME,
        result.rawToken,
        cookieOptions(dependencies.cookieSecure, result.expiresAt)
      );
      sendData(response, {
        principal: result.principal,
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt.toISOString()
      });
    } catch (error: unknown) {
      next(error);
    }
  };
}

function sessionHandler(dependencies: AuthRouterDependencies): RequestHandler {
  return (request, response, next): void => {
    if (!request.auth) {
      next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
      return;
    }
    sendData(response, {
      principal: request.auth.principal,
      csrfToken: request.auth.csrfToken,
      expiresAt: request.auth.expiresAt.toISOString()
    });
  };
}

function logoutHandler(dependencies: AuthRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      if (!request.auth) {
        clearSessionCookie(response, dependencies.cookieSecure);
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      await dependencies.logout.execute(request.auth.sessionId);
      clearSessionCookie(response, dependencies.cookieSecure);
      response.status(204).send();
    } catch (error: unknown) {
      next(error);
    }
  };
}

export function createAuthRouter(dependencies: AuthRouterDependencies): Router {
  const router = Router();
  const clearCookie = (response: Response): void => clearSessionCookie(response, dependencies.cookieSecure);
  router.post('/login', sameOrigin(dependencies.appOrigin), loginHandler(dependencies));
  router.get('/session', authenticateRequest(dependencies.getSession, clearCookie), sessionHandler(dependencies));
  router.post(
    '/logout',
    sameOrigin(dependencies.appOrigin),
    authenticateRequest(dependencies.getSession, clearCookie),
    requireCsrf,
    logoutHandler(dependencies)
  );
  return router;
}
