import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { ActionUndoConflictError, ActionUndoDomainError } from '@/modules/home-assistant/domain/action-undo-errors';
import type { ActionLedgerRecord } from '@/modules/action-ledger/domain/action-ledger-types';
import type { IActionUndoUseCases } from '@/modules/home-assistant/use-cases/action-undo-use-cases';
import type { GlobalTaskQueryItem } from '@/modules/tasks/domain/global-task-query';
import type { Project } from '@/modules/projects/domain/project-types';
import { authenticateRequest, requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { AppError } from '@/shared/errors/app-error';
import type { Response as ExpressResponse } from 'express';

const undoBodySchema = z.object({
  completedTaskCreateActionIds: z.array(z.string().uuid()).max(100).optional()
}).strict();

export interface ActionUndoRouterDependencies {
  readonly getSession: GetSessionUseCase;
  readonly undoAction: IActionUndoUseCases;
  readonly appOrigin: string;
  readonly clearSessionCookie: (response: Response) => void;
}

function parseBody(body: unknown): z.infer<typeof undoBodySchema> {
  const parsed = undoBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 400, 'The undo request is invalid.', parsed.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request',
      message: issue.message
    })));
  }
  return parsed.data;
}

function serializeAction(record: ActionLedgerRecord): Record<string, unknown> {
  return {
    id: record.id,
    actionKind: record.actionKind,
    actorKind: record.actorKind,
    turnId: record.turnId,
    targetKind: record.targetKind,
    targetId: record.targetId,
    preVersion: record.preVersion,
    postVersion: record.postVersion,
    outcome: record.outcome,
    undoStatus: record.undoStatus,
    undoActionId: record.undoActionId,
    createdAt: record.createdAt
  };
}

function serializeReceiptMetadata(record: ActionLedgerRecord): Record<string, unknown> {
  return {
    id: record.id,
    actionKind: record.actionKind,
    actorKind: record.actorKind,
    turnId: record.turnId,
    targetKind: record.targetKind,
    targetId: record.targetId,
    postVersion: record.postVersion,
    undoStatus: record.undoStatus,
    undoActionId: record.undoActionId
  };
}

function serializeTaskItem(item: GlobalTaskQueryItem): Record<string, unknown> {
  const task = item.task;
  return {
    task: {
      ...task,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      completedAt: task.completedAt?.toISOString() ?? null,
      archivedAt: task.archivedAt?.toISOString() ?? null,
      source: { ...task.source, acceptedAt: task.source.acceptedAt?.toISOString() ?? null }
    },
    collection: item.collection,
    workspace: item.workspace
  };
}

function serializeTarget(target: GlobalTaskQueryItem | Project | null): Record<string, unknown> | null {
  if (target === null) return null;
  if ('task' in target) return { kind: 'task', item: serializeTaskItem(target) };
  return {
    kind: 'workspace',
    workspace: {
      id: target.id,
      name: target.name,
      slug: target.slug,
      relativeRoot: target.relativeRoot,
      storageKind: 'legacy',
      objective: target.objective,
      status: target.status,
      version: target.version,
      createdAt: target.createdAt.toISOString(),
      updatedAt: target.updatedAt.toISOString()
    }
  };
}

function undoHandler(dependencies: ActionUndoRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const actionId = request.params.actionId;
      if (typeof actionId !== 'string' || !z.string().uuid().safeParse(actionId).success) {
        next(new AppError('VALIDATION_ERROR', 400, 'The action ID must be a UUID.'));
        return;
      }
      const body = parseBody(request.body);
      const result = await dependencies.undoAction.undo({
        ownerId,
        actionId,
        operationKey: request.header('idempotency-key'),
        ...(body.completedTaskCreateActionIds === undefined ? {} : { completedTaskCreateActionIds: body.completedTaskCreateActionIds })
      });
      response.status(200).json({
        data: {
          originalAction: serializeAction(result.originalAction),
          undoReceipt: serializeAction(result.undoReceipt),
          target: serializeTarget(result.target),
          replayed: result.replayed
        },
        error: null
      });
    } catch (error: unknown) {
      if (error instanceof ActionUndoConflictError) {
        sendConflict(response, error);
        return;
      }
      if (error instanceof ActionUndoDomainError) {
        next(new AppError(error.code, error.statusCode, error.message));
        return;
      }
      next(error);
    }
  };
}

function receiptHandler(dependencies: ActionUndoRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) {
        next(new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.'));
        return;
      }
      const actionId = request.params.actionId;
      if (typeof actionId !== 'string' || !z.string().uuid().safeParse(actionId).success) {
        next(new AppError('VALIDATION_ERROR', 400, 'The action ID must be a UUID.'));
        return;
      }
      const record = await dependencies.undoAction.getReceipt({ ownerId, actionId });
      response.status(200).json({ data: serializeReceiptMetadata(record), error: null });
    } catch (error: unknown) {
      if (error instanceof ActionUndoDomainError) {
        next(new AppError(error.code, error.statusCode, error.message));
        return;
      }
      next(error);
    }
  };
}

function sendConflict(response: ExpressResponse, error: ActionUndoConflictError): void {
  response.status(409).json({
    data: {
      originalAction: serializeAction(error.originalAction),
      target: serializeTarget(error.target as GlobalTaskQueryItem | Project | null),
      reason: error.reason
    },
    error: { code: error.code, message: error.message }
  });
}

export function createActionUndoRouter(dependencies: ActionUndoRouterDependencies): Router {
  const router = Router();
  const authenticate = authenticateRequest(dependencies.getSession, dependencies.clearSessionCookie);
  router.get('/:actionId', authenticate, receiptHandler(dependencies));
  router.post('/:actionId/undo', sameOrigin(dependencies.appOrigin), authenticate, requireCsrf, undoHandler(dependencies));
  return router;
}
