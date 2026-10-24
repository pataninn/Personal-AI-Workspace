import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { projectReducer, type ProjectSnapshot, type ProjectState } from '@/entities/project';
import { ProjectHeader } from '@/widgets/project-navigation/ProjectHeader';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function renderProjectHeader(fileAccess: boolean, path = `/projects/${PROJECT_ID}/planning-chat`): void {
  const project: ProjectSnapshot = {
    id: PROJECT_ID,
    name: 'Launch plan',
    slug: 'launch-plan',
    workspaceMode: fileAccess ? 'file_backed' : 'planning',
    capabilities: { planning: true, fileAccess },
    status: 'active',
    version: 1,
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z'
  };
  const projectState: ProjectState = { listStatus: 'success', projects: [project], errorCode: null, detailById: {} };
  const store = configureStore({ reducer: { project: projectReducer }, preloadedState: { project: projectState } });

  render(<Provider store={store}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/projects/:projectId/*" element={<ProjectHeader onRemove={() => undefined} />} />
  </Routes></MemoryRouter></Provider>);
}

describe('ProjectHeader capability navigation', () => {
  it('offers planning chat for planning-only workspaces alongside Memory and Tasks', () => {
    renderProjectHeader(false);

    expect(screen.getByText('Planning only')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Planning chat' })).toHaveAttribute('href', `/projects/${PROJECT_ID}/planning-chat`);
    expect(screen.getByRole('link', { name: 'Memory' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Automations' })).not.toBeInTheDocument();
  });

  it('shows file navigation only when the project has file capability', () => {
    renderProjectHeader(true, `/projects/${PROJECT_ID}`);

    expect(screen.getByRole('link', { name: 'Context' })).toBeInTheDocument();
    expect(screen.getByText('Files available')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Memory' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Planning chat' })).not.toBeInTheDocument();
  });
});
