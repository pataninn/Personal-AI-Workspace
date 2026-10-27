import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectReducer, type ProjectSnapshot, type ProjectState } from '@/entities/project';
import { userSessionReducer } from '@/entities/user-session';
import { RenameProjectDialog } from '@/features/project-management/ui/RenameProjectDialog';
import { ApiClientError } from '@/shared/api';

const { rename, list, get } = vi.hoisted(() => ({ rename: vi.fn(), list: vi.fn(), get: vi.fn() }));
vi.mock('@/entities/project/api/project-api', async (original) => ({ ...await original<typeof import('@/entities/project/api/project-api')>(), renameProject: rename, listProjects: list, getProject: get }));
const project: ProjectSnapshot = { id: '11111111-1111-4111-8111-111111111111', name: 'Before', slug: 'before', workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false }, status: 'active', version: 2, createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' };
function setup() {
  const state: ProjectState = { listStatus: 'success', projects: [project], errorCode: null, detailById: {} };
  const store = configureStore({ reducer: { project: projectReducer, userSession: userSessionReducer }, preloadedState: { project: state, userSession: { status: 'authenticated' as const, principal: { id: 'owner', displayName: 'Owner', accountKind: 'regular' as const, role: 'admin' as const }, csrfToken: 'csrf', expiresAt: '2026-10-25T00:00:00Z', errorCode: null } } });
  const close = vi.fn();
  render(<Provider store={store}><RenameProjectDialog project={project} onClose={close} /></Provider>);
  return { store, close };
}
describe('RenameProjectDialog', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('prefills the name and saves a persistent rename to the list and detail state', async () => {
    const updated = { ...project, name: 'After', version: 3 };
    rename.mockResolvedValue(updated); list.mockResolvedValue({ projects: [updated] }); get.mockResolvedValue(updated);
    const { store, close } = setup(); const user = userEvent.setup();
    expect(screen.getByLabelText('Workspace name')).toHaveValue('Before');
    await user.clear(screen.getByLabelText('Workspace name'));
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
    await user.type(screen.getByLabelText('Workspace name'), 'After');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(rename).toHaveBeenCalledWith(project.id, 'After', 2, 'csrf');
    expect(store.getState().project.projects[0]?.name).toBe('After');
    expect(store.getState().project.detailById[project.id]?.project?.name).toBe('After');
  });
  it('keeps the dialog open with actionable duplicate-name feedback', async () => {
    rename.mockRejectedValue(new ApiClientError(409, 'PROJECT_NAME_CONFLICT', 'Conflict'));
    const { close } = setup(); const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Workspace name')); await user.type(screen.getByLabelText('Workspace name'), 'Taken');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(close).not.toHaveBeenCalled();
  });
  it('cancels without saving', async () => {
    const { close } = setup(); await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
  });
});
