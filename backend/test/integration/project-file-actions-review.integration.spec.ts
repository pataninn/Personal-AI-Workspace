import express from 'express';
import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import request from 'supertest';

import { createApp } from '@/app';
import type { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import { InMemoryReadinessState } from '@/infrastructure/startup/readiness-state';
import { GetReadinessUseCase } from '@/modules/health';
import { ProjectFileActions } from '@/modules/files/use-cases/project-file-actions';
import type { IProjectFileAccess, IProjectFileGateway } from '@/modules/files/repositories/project-file-access';
import type { WorkspaceRouterDependencies } from '@/modules/files/controllers/workspace-router';
import { createLogger } from '@/shared/logging/logger';
import { ProjectFileGateway } from '@/infrastructure/workspace/project-file-gateway';

const ORIGIN = 'https://127.0.0.1:8443';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const BASE = `/api/v1/projects/${PROJECT}/files`;
const HASH = 'a'.repeat(64);
const HEADERS = { Origin: ORIGIN, Cookie: '__Host-pa_session=valid', 'X-CSRF-Token': 'csrf' };

function fixture(): { app: express.Express; gateway: jest.Mocked<IProjectFileGateway> } {
  const gateway: jest.Mocked<IProjectFileGateway> = {
    write: jest.fn().mockResolvedValue({ hash: HASH }), remove: jest.fn().mockResolvedValue(undefined),
    download: jest.fn().mockResolvedValue({ bytes: Buffer.from([0, 255]), hash: HASH })
  };
  const access: IProjectFileAccess = { execute: async (_input, action) => action({ projectId: PROJECT, relativeRoot: 'folder' }) };
  const getSession = { execute: jest.fn().mockImplementation(async (token: unknown) => {
    if (token !== 'valid') throw new UnauthenticatedError();
    return { sessionId: 'session', principal: { id: 'owner' }, csrfToken: 'csrf', expiresAt: new Date('2099-01-01') };
  }) } as unknown as GetSessionUseCase;
  const unused = { execute: jest.fn() };
  const workspace = { getSession, appOrigin: ORIGIN, clearSessionCookie: () => undefined, fileActions: new ProjectFileActions(access, gateway),
    listWorkspaceFiles: unused, treeWorkspaceFiles: unused, readWorkspaceText: unused, searchWorkspaceText: unused } as unknown as WorkspaceRouterDependencies;
  const readiness = new InMemoryReadinessState();
  readiness.markReady();
  return { app: createApp({ logger: createLogger('silent'), appVersion: 'test', readiness: new GetReadinessUseCase(readiness), workspace }), gateway };
}

describe('manual file HTTP review', () => {
  it('round trips raw binary buffers and returns a download hash and attachment filename', async () => {
    const { app, gateway } = fixture();
    const bytes = Buffer.from([0, 255, 128, 4]);
    await request(app).post(`${BASE}/upload?path=image.png`).set(HEADERS).type('application/octet-stream').send(bytes).expect(201);
    expect(gateway.write).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ bytes, path: 'image.png', expectedHash: null }));
    const result = await request(app).get(`${BASE}/download?path=image.png`).set('Cookie', HEADERS.Cookie).expect(200);
    expect(result.headers.etag).toBe(`"${HASH}"`);
    expect(result.headers['content-disposition']).toContain("filename*=UTF-8''image.png");
  });

  it('requires session, same origin and CSRF for file mutations', async () => {
    const { app, gateway } = fixture();
    await request(app).post(`${BASE}/upload?path=image.png`).set('Origin', ORIGIN).type('application/octet-stream').send(Buffer.from('x')).expect(401);
    await request(app).delete(`${BASE}/content?path=image.png`).set('Cookie', HEADERS.Cookie).expect(403);
    await request(app).delete(`${BASE}/content?path=image.png`).set({ Cookie: HEADERS.Cookie, Origin: ORIGIN }).expect(403);
    expect(gateway.write).not.toHaveBeenCalled();
    expect(gateway.remove).not.toHaveBeenCalled();
  });

  it('validates delete hashes before calling the gateway', async () => {
    const { app, gateway } = fixture();
    await request(app).delete(`${BASE}/content?path=image.png`).set(HEADERS).expect(400);
    await request(app).delete(`${BASE}/content?path=image.png`).set(HEADERS).set('If-Match', 'stale').expect(400);
    await request(app).delete(`${BASE}/content?path=image.png`).set(HEADERS).set('If-Match', `"${HASH}"`).expect(204);
    expect(gateway.remove).toHaveBeenCalledTimes(1);
  });

  it('reports oversized raw uploads with 413 before reaching the file gateway', async () => {
    const { app, gateway } = fixture();
    await request(app).post(`${BASE}/upload?path=large.png`).set(HEADERS).type('application/octet-stream').send(Buffer.alloc(8 * 1024 * 1024 + 1)).expect(413);
    expect(gateway.write).not.toHaveBeenCalled();
  });

  it('reports files removed externally as 404 instead of an internal server error', async () => {
    const { app, gateway } = fixture();
    const missing = Object.assign(new Error('File gone'), { code: 'ENOENT' });
    const realpath = jest.spyOn(fs, 'realpath').mockImplementation(async (value) => String(value));
    const lstat = jest.spyOn(fs, 'lstat').mockImplementation(async (value) => {
      if (String(value).endsWith('/gone.txt')) throw missing;
      return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } as Stats;
    });
    const open = jest.spyOn(fs, 'open').mockRejectedValue(missing);
    const actual = new ProjectFileGateway({ containerRoot: '/test-root', workspaceBoundary: {
      assertReady: async () => undefined, getSnapshot: async () => ({ status: 'ready' }), validateProjectRoot: async (value) => value
    } });
    gateway.download.mockImplementation((scope, relativePath) => actual.download(scope, relativePath));
    try {
      await request(app).get(`${BASE}/download?path=gone.txt`).set('Cookie', HEADERS.Cookie).expect(404);
    } finally { open.mockRestore(); lstat.mockRestore(); realpath.mockRestore(); }
  });
});
