import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppStore } from '@/app/store/store';
import { loadProject, loadProjects, projectCreated, projectStatusUpdated, type ProjectSnapshot } from '@/entities/project';
import { sessionAuthenticated, sessionCleared } from '@/entities/user-session';
import { useProjectListLoader } from '@/features/project-management/model/use-projects';
import { ApiClientError, getJson, notifySessionExpiry, registerSessionExpiryHandler } from '@/shared/api';

const api = vi.hoisted(() => ({ listProjects: vi.fn(), getProject: vi.fn() }));
vi.mock('@/entities/project/api/project-api', async (importOriginal) => ({ ...await importOriginal(), ...api }));

const project: ProjectSnapshot = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Private workspace', slug: 'private-workspace',
  workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false }, status: 'active', version: 1,
  createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z'
};
const session = (id: string) => ({ principal: { id, displayName: id, accountKind: 'regular' as const, role: 'user' as const }, csrfToken: `csrf-${id}`, expiresAt: '2026-10-28T00:00:00Z' });
const makeStore = createAppStore;

beforeEach(() => { vi.clearAllMocks(); });

describe('project cache session boundary', () => {
  it('clears private metadata and refetches the next principal list', async () => {
    const store = makeStore();
    store.dispatch(sessionAuthenticated(session('owner-a')));
    api.listProjects.mockResolvedValueOnce({ projects: [project] }).mockResolvedValue({ projects: [] });
    await store.dispatch(loadProjects());
    expect(store.getState().project.projects).toEqual([project]);
    store.dispatch(sessionCleared('signed-out'));
    store.dispatch(sessionAuthenticated(session('demo-b')));
    expect(store.getState().project).toMatchObject({ projects: [], detailById: {}, listStatus: 'idle' });
    function wrapper({ children }: { readonly children: ReactNode }): React.JSX.Element { return <Provider store={store}>{children}</Provider>; }
    renderHook(() => useProjectListLoader(), { wrapper });
    await waitFor(() => expect(store.getState().project.listStatus).toBe('success'));
    expect(api.listProjects).toHaveBeenCalledTimes(2);
    expect(store.getState().project.projects).toEqual([]);
  });

  it('rejects old list responses even after returning to the same owner', async () => {
    const store = makeStore();
    store.dispatch(sessionAuthenticated(session('owner-a')));
    let resolveOld: (value: { projects: ProjectSnapshot[] }) => void = () => { throw new Error('Request not started'); };
    api.listProjects.mockReturnValueOnce(new Promise<{ projects: ProjectSnapshot[] }>((resolve) => { resolveOld = resolve; }));
    const oldRequest = store.dispatch(loadProjects());
    store.dispatch(sessionCleared('signed-out'));
    store.dispatch(sessionAuthenticated(session('demo-b')));
    store.dispatch(sessionAuthenticated(session('owner-a')));
    api.listProjects.mockResolvedValueOnce({ projects: [] });
    await store.dispatch(loadProjects());
    resolveOld({ projects: [project] });
    await oldRequest;
    expect(store.getState().project).toMatchObject({ projects: [], listStatus: 'success' });
  });

  it('rejects late project details and failures from a prior session', async () => {
    const store = makeStore();
    store.dispatch(sessionAuthenticated(session('owner-a')));
    let resolveOld: (value: ProjectSnapshot) => void = () => { throw new Error('Request not started'); };
    api.getProject.mockReturnValueOnce(new Promise<ProjectSnapshot>((resolve) => { resolveOld = resolve; }));
    const oldRequest = store.dispatch(loadProject(project.id));
    store.dispatch(sessionCleared('signed-out'));
    store.dispatch(sessionAuthenticated(session('demo-b')));
    resolveOld(project);
    await oldRequest;
    store.dispatch(loadProject.rejected(new Error('Old request failed'), 'old-request', project.id));
    expect(store.getState().project).toMatchObject({ projects: [], detailById: {} });
  });

  it('rejects late create and status mutations from a previous session generation', () => {
    const store = makeStore();
    store.dispatch(sessionAuthenticated(session('owner-a')));
    const generation = store.getState().project.generation ?? 0;
    store.dispatch(sessionCleared('signed-out'));
    store.dispatch(sessionAuthenticated(session('owner-a')));
    store.dispatch(projectCreated(project, generation));
    store.dispatch(projectStatusUpdated(project, generation));
    expect(store.getState().project.projects).toEqual([]);
    store.dispatch(projectCreated(project, store.getState().project.generation ?? 0));
    expect(store.getState().project.projects).toEqual([project]);
  });

  it('does not clear a new session when an actual old JSON request returns unauthorized', async () => {
    const store = makeStore();
    store.dispatch(sessionAuthenticated(session('owner-a')));
    const unregister = registerSessionExpiryHandler(() => { store.dispatch(sessionCleared('SESSION_UNAUTHENTICATED')); });
    let resolveOld: (response: Response) => void = () => { throw new Error('Request not started'); };
    const fetchImplementation = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>((resolve) => { resolveOld = resolve; }));
    const oldRequest = getJson('/api/v1/projects', fetchImplementation);
    store.dispatch(sessionCleared('signed-out'));
    store.dispatch(sessionAuthenticated(session('demo-b')));
    resolveOld(new Response(JSON.stringify({ data: null, error: { code: 'SESSION_UNAUTHENTICATED', message: 'Old session expired' } }), { status: 401 }));
    try {
      await oldRequest;
      throw new Error('The request should reject');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApiClientError);
      if (error instanceof ApiClientError) notifySessionExpiry(error.statusCode, error.code, error);
      expect(store.getState().userSession).toMatchObject({ status: 'authenticated', principal: { id: 'demo-b' } });
    } finally { unregister(); }
  });
});
