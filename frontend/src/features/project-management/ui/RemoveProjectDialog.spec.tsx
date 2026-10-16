import { useState } from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { projectReducer, type ProjectSnapshot, type ProjectState } from '@/entities/project';
import { userSessionReducer } from '@/entities/user-session';
import { RemoveProjectDialog } from '@/features/project-management/ui/RemoveProjectDialog';
import { ApiClientError } from '@/shared/api';

const { listProjectsMock, removeProjectMock } = vi.hoisted(() => ({
  listProjectsMock: vi.fn(),
  removeProjectMock: vi.fn()
}));

vi.mock('@/entities/project/api/project-api', () => ({
  listProjects: listProjectsMock,
  removeProject: removeProjectMock
}));

const PROJECT: ProjectSnapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Website',
  slug: 'website',
  relativeRoot: 'apps/website',
  status: 'active',
  version: 4,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z'
};

const SESSION = {
  status: 'authenticated' as const,
  principal: { id: 'user-1', displayName: 'Local user' },
  csrfToken: 'csrf-value',
  expiresAt: '2026-09-13T00:00:00.000Z',
  errorCode: null
};

function renderRemovalDialog(): void {
  const projectState: ProjectState = { listStatus: 'success', projects: [PROJECT], errorCode: null, detailById: {} };
  const store = configureStore({ reducer: { project: projectReducer, userSession: userSessionReducer }, preloadedState: { project: projectState, userSession: SESSION } });

  function RemovalDialogHarness(): React.JSX.Element {
    const [project, setProject] = useState<ProjectSnapshot | null>(PROJECT);
    return <>
      <button type="button" onClick={() => setProject(PROJECT)}>Open removal dialog</button>
      <RemoveProjectDialog project={project} onOpenChange={(open) => { if (!open) setProject(null); }} onRemoved={() => setProject(null)} />
    </>;
  }

  render(<Provider store={store}><RemovalDialogHarness /></Provider>);
}

describe('RemoveProjectDialog', () => {
  beforeEach(() => {
    listProjectsMock.mockReset().mockResolvedValue({ projects: [] });
    removeProjectMock.mockReset();
  });

  it('waits for explicit confirmation and explains that the project folder stays on disk', async () => {
    removeProjectMock.mockResolvedValue(undefined);
    renderRemovalDialog();
    const user = userEvent.setup();

    const dialog = screen.getByRole('alertdialog', { name: 'Remove Website?' });
    expect(dialog).toHaveTextContent('project folder and its files stay on your computer');
    expect(removeProjectMock).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('project-remove-cancel'));
    expect(removeProjectMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Open removal dialog' }));
    await user.click(screen.getByTestId('project-remove-confirm'));
    await waitFor(() => expect(removeProjectMock).toHaveBeenCalledWith(PROJECT.id, PROJECT.version, 'csrf-value'));
    expect(listProjectsMock).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('keeps a failed removal open with the server reason and allows retry', async () => {
    removeProjectMock.mockRejectedValueOnce(new ApiClientError(409, 'PROJECT_BUSY', 'Stop the active run before removing this project.')).mockResolvedValue(undefined);
    renderRemovalDialog();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('project-remove-confirm'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Stop the active run');
    expect(screen.getByRole('alertdialog', { name: 'Remove Website?' })).toBeInTheDocument();
    expect(screen.getByTestId('project-remove-confirm')).toBeEnabled();

    await user.click(screen.getByTestId('project-remove-confirm'));
    await waitFor(() => expect(removeProjectMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('reports pending backup cleanup after removal without offering deletion again', async () => {
    removeProjectMock.mockRejectedValue(new ApiClientError(503, 'PROJECT_REMOVAL_CLEANUP_PENDING', 'Cleanup pending'));
    renderRemovalDialog();

    await userEvent.setup().click(screen.getByTestId('project-remove-confirm'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Project removed' });
    expect(dialog).toHaveTextContent('Restart the app to retry cleanup');
    expect(screen.queryByTestId('project-remove-confirm')).not.toBeInTheDocument();
    expect(listProjectsMock).toHaveBeenCalledOnce();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });
});
