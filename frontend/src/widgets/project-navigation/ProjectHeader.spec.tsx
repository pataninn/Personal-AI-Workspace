import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { projectReducer, type ProjectSnapshot, type ProjectState } from '@/entities/project';
import { ProjectHeader } from '@/widgets/project-navigation/ProjectHeader';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function renderProjectHeader(relativeRoot: string | null, path = `/projects/${PROJECT_ID}/planning-chat`): void {
  const project: ProjectSnapshot = {
    id: PROJECT_ID,
    name: 'Launch plan',
    slug: 'launch-plan',
    relativeRoot,
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

describe('ProjectHeader planning chat navigation', () => {
  it('offers planning chat for rootless workspaces alongside Memory and Tasks', () => {
    renderProjectHeader(null);

    expect(screen.getByText('Planning workspace')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Planning chat' })).toHaveAttribute('href', `/projects/${PROJECT_ID}/planning-chat`);
    expect(screen.getByRole('link', { name: 'Memory' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('hides planning chat for every file-backed root including the dot root', () => {
    renderProjectHeader('.');

    expect(screen.getByRole('link', { name: 'Context' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Memory' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Planning chat' })).not.toBeInTheDocument();
  });
});
