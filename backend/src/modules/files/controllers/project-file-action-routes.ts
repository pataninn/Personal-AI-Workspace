import express, { type Request, type Response, type NextFunction, type Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { ProjectFileActions } from '@/modules/files/use-cases/project-file-actions';
import { requireCsrf, sameOrigin } from '@/modules/auth/controllers/request-auth';
import { sendData } from '@/shared/http/response';
import { AppError } from '@/shared/errors/app-error';

const textSchema = z.object({ path: z.string().min(1).max(2048), content: z.string().max(512 * 1024), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();

interface FileRouteOptions {
  readonly router: Router;
  readonly authenticate: RequestHandler;
  readonly appOrigin: string;
  readonly actions: ProjectFileActions;
}

/** Add manual file routes after the authenticated inspection routes. */
export function addProjectFileActionRoutes(options: FileRouteOptions): void {
  const { router, authenticate, actions } = options;
  const guard = [sameOrigin(options.appOrigin), authenticate, requireCsrf];
  router.get('/download', authenticate, handler(async (request, response) => {
    const input = scope(request);
    const result = await actions.download(input);
    const name = input.path.split('/').at(-1) ?? 'file';
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    response.setHeader('ETag', `"${result.hash}"`);
    response.send(result.bytes);
  }));
  router.post('/upload', ...guard, express.raw({ type: 'application/octet-stream', limit: '8mb' }), handler(async (request, response) => {
    if (!Buffer.isBuffer(request.body)) throw new AppError('VALIDATION_ERROR', 400, 'Choose a file to upload.');
    const result = await actions.upload({ ...scope(request), bytes: request.body });
    sendData(response, result, 201);
  }));
  router.put('/content', ...guard, handler(async (request, response) => {
    const parsed = textSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 400, 'The file edit is invalid.');
    const result = await actions.write({ ...scope(request, parsed.data.path), bytes: Buffer.from(parsed.data.content, 'utf8'), expectedHash: parsed.data.expectedHash });
    sendData(response, result);
  }));
  router.delete('/content', ...guard, handler(async (request, response) => {
    const expectedHash = request.header('if-match')?.replace(/^"|"$/gu, '') ?? '';
    await actions.remove({ ...scope(request), expectedHash });
    response.status(204).end();
  }));
}

function scope(request: Request, filePath?: string): { ownerId: string; projectId: string; path: string } {
  const ownerId = request.auth?.principal.id;
  const projectId = request.params.projectId;
  const value = filePath ?? request.query.path;
  if (!ownerId) throw new AppError('SESSION_UNAUTHENTICATED', 401, 'A valid local session is required.');
  if (typeof projectId !== 'string' || !/^[a-f0-9-]{36}$/iu.test(projectId) || typeof value !== 'string' || value.length > 2048) throw new AppError('VALIDATION_ERROR', 400, 'Choose a project file.');
  return { ownerId, projectId, path: value };
}

function handler(action: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => { void action(request, response).catch(next); };
}
