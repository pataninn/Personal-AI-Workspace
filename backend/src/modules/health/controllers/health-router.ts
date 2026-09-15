import { Router, type RequestHandler } from 'express';

import { GetLivenessUseCase } from '@/modules/health/use-cases/get-liveness';
import { GetReadinessUseCase } from '@/modules/health/use-cases/get-readiness';
import { sendData } from '@/shared/http/response';

export interface HealthRouterDependencies {
  readonly getLiveness: GetLivenessUseCase;
  readonly getReadiness: GetReadinessUseCase;
  readonly appVersion: string;
}

function livenessHandler(dependencies: HealthRouterDependencies): RequestHandler {
  return (_request, response) => {
    sendData(response, dependencies.getLiveness.execute());
  };
}

function readinessHandler(dependencies: HealthRouterDependencies): RequestHandler {
  return (_request, response) => {
    const snapshot = dependencies.getReadiness.execute();
    const statusCode = snapshot.status === 'ready' ? 200 : 503;
    sendData(response, {
      status: snapshot.status,
      version: dependencies.appVersion,
      ...(snapshot.status === 'not_ready' ? { failures: snapshot.failures } : {})
    }, statusCode);
  };
}

export function createHealthRouter(dependencies: HealthRouterDependencies): Router {
  const router = Router();
  router.get('/health', livenessHandler(dependencies));
  router.get('/ready', readinessHandler(dependencies));
  return router;
}
