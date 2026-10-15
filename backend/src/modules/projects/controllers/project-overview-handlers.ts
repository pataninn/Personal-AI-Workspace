import type { RequestHandler } from 'express';
import { z } from 'zod';

import type { ProjectRouterDependencies } from '@/modules/projects/controllers/project-router';
import { ProjectNotFoundError, ProjectVersionRequiredError } from '@/modules/projects/domain/project-errors';
import { projectCapabilities, projectWorkspaceMode } from '@/modules/projects/domain/project-types';
import { AppError } from '@/shared/errors/app-error';
import { sendData } from '@/shared/http/response';

const taskLimitSchema = z.union([z.string().regex(/^\d+$/u).transform(Number), z.number()]).pipe(z.number().int().min(1).max(100));
const projectIdSchema = z.string().uuid();

/** Owner-scoped overview; the query controls only the bounded task count. */
export function overviewHandler(dependencies: ProjectRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
      const taskLimit = taskLimitSchema.safeParse(request.query.taskLimit ?? 6);
      if (!taskLimit.success) throw new AppError('VALIDATION_ERROR', 400, 'taskLimit must be an integer from 1 to 100.');
      if (!dependencies.getOverview) throw new AppError('PROJECT_OVERVIEW_UNAVAILABLE', 503, 'The project overview is unavailable.');
      const overview = await dependencies.getOverview.execute({ ownerId, taskLimit: taskLimit.data });
      sendData(response, { projects: overview.projects.map(({ ownerId: _ownerId, ...project }) => ({
        ...project, workspaceMode: projectWorkspaceMode(project), capabilities: projectCapabilities(project),
        createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString(), lastActivityAt: project.lastActivityAt.toISOString()
      })), tasks: overview.tasks });
    } catch (error: unknown) { next(error); }
  };
}

/** Removes only owned application data after version and CSRF validation. */
export function deleteProjectHandler(dependencies: ProjectRouterDependencies): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      const ownerId = request.auth?.principal.id;
      if (!ownerId) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
      const projectId = projectIdSchema.safeParse(request.params.projectId);
      if (!projectId.success) throw new ProjectNotFoundError();
      const header = request.header('if-match');
      const version = Number(header);
      if (!header || !/^\d+$/u.test(header) || !Number.isSafeInteger(version) || version < 1) throw new ProjectVersionRequiredError();
      if (!dependencies.deleteProject) throw new AppError('PROJECT_REMOVAL_UNAVAILABLE', 503, 'Project removal is unavailable.');
      await dependencies.deleteProject.execute({ ownerId, projectId: projectId.data, expectedVersion: version });
      response.status(204).end();
    } catch (error: unknown) { next(error); }
  };
}
