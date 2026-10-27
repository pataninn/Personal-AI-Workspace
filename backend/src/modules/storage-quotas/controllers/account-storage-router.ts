import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';

import { authenticateRequest } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import type { GetStorageUsage } from '@/modules/storage-quotas/use-cases/get-storage-usage';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

export interface AccountStorageRouterDependencies {
  readonly getStorageUsage: GetStorageUsage;
  readonly getSession: GetSessionUseCase;
  readonly clearSessionCookie: (response: Response) => void;
}

function ownerId(request: Request): string {
  const id = request.auth?.principal.id;
  if (!id) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
  return id;
}

function storageHandler(dependencies: AccountStorageRouterDependencies): RequestHandler {
  return (request, response, next): void => {
    void (async (): Promise<void> => {
      const storage = await dependencies.getStorageUsage.execute(ownerId(request));
      sendData(response, { storage });
    })().catch(next);
  };
}

export function createAccountStorageRouter(dependencies: AccountStorageRouterDependencies): Router {
  const router = Router();
  router.get(
    '/account/storage',
    authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie),
    storageHandler(dependencies)
  );
  return router;
}
