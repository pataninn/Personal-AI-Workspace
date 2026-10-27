import { timingSafeEqual } from 'node:crypto';

import type { RequestHandler } from 'express';

import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import type { AuthSessionSnapshot } from '@/modules/auth/domain/auth-types';
import { AppError } from '@/shared/errors/app-error';

export const SESSION_COOKIE_NAME = '__Host-pa_session';

export interface AuthenticatedRequestState {
  readonly sessionId: string;
  readonly principal: AuthSessionSnapshot['principal'];
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedRequestState;
    }
  }
}

export {};

export function sameOrigin(origin: string): RequestHandler {
  return (request, _response, next): void => {
    if (request.header('origin') !== origin) {
      next(new AppError('ORIGIN_FORBIDDEN', 403, 'The request origin is not allowed.'));
      return;
    }
    next();
  };
}

/** Authenticates without mutating browser cookies; the legacy callback is kept for router compatibility. */
export function authenticateRequest(
  getSession: GetSessionUseCase,
  _clearCookie?: (response: Parameters<RequestHandler>[1]) => void
): RequestHandler {
  return async (request, _response, next): Promise<void> => {
    try {
      const snapshot = await getSession.execute(request.cookies?.[SESSION_COOKIE_NAME]);
      request.auth = {
        sessionId: snapshot.sessionId,
        principal: snapshot.principal,
        csrfToken: snapshot.csrfToken,
        expiresAt: snapshot.expiresAt
      };
      next();
    } catch (error: unknown) {
      // A delayed response may belong to an older session than the browser now holds.
      // Only explicit logout may expire the browser cookie; authorization still fails here.
      next(error);
    }
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export const requireCsrf: RequestHandler = (request, _response, next): void => {
  const expected = request.auth?.csrfToken;
  const provided = request.header('x-csrf-token');
  if (!expected || !provided || !constantTimeEqual(provided, expected)) {
    next(new AppError('CSRF_INVALID', 403, 'The request could not be verified.'));
    return;
  }
  next();
};
