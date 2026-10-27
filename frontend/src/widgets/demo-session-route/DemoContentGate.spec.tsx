import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionAuthenticated, userSessionReducer } from '@/entities/user-session';
import { DemoContentGate } from '@/widgets/demo-session-route';

const { getDemoShowcaseCopyMock, retryDemoShowcaseCopyMock } = vi.hoisted(() => ({
  getDemoShowcaseCopyMock: vi.fn(),
  retryDemoShowcaseCopyMock: vi.fn()
}));

vi.mock('@/entities/demo', () => ({
  getDemoShowcaseCopy: getDemoShowcaseCopyMock,
  retryDemoShowcaseCopy: retryDemoShowcaseCopyMock
}));

function renderGate(): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer } });
  store.dispatch(sessionAuthenticated({
    principal: { id: 'demo-owner', displayName: 'Demo workspace', accountKind: 'demo', role: 'user' },
    csrfToken: 'csrf-demo',
    expiresAt: '2026-10-20T00:00:00.000Z'
  }));
  render(<Provider store={store}><MemoryRouter initialEntries={['/dashboard']}><DemoContentGate><LocationProbe /><p>Private project data</p></DemoContentGate></MemoryRouter></Provider>);
}

function renderInitialDemoEntry(): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer } });
  store.dispatch(sessionAuthenticated({
    principal: { id: 'demo-owner', displayName: 'Demo workspace', accountKind: 'demo', role: 'user' },
    csrfToken: 'csrf-demo',
    expiresAt: '2026-10-20T00:00:00.000Z'
  }));
  render(<Provider store={store}><MemoryRouter initialEntries={[{ pathname: '/dashboard', state: { demoAdmissionEntry: true } }]}><DemoContentGate><LocationProbe /><p>Private project data</p></DemoContentGate></MemoryRouter></Provider>);
}

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="gate-location">{location.pathname}</output>;
}

describe('DemoContentGate', () => {
  beforeEach(() => {
    getDemoShowcaseCopyMock.mockReset();
    retryDemoShowcaseCopyMock.mockReset();
  });

  it('keeps private content hidden until a server-approved retry becomes ready', async () => {
    getDemoShowcaseCopyMock.mockResolvedValue({ state: 'failed', projectId: null, retryAllowed: true, workspaceMode: null, capabilities: null });
    retryDemoShowcaseCopyMock.mockResolvedValue({
      state: 'ready', projectId: '11111111-1111-4111-8111-111111111111', retryAllowed: false, workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false }
    });
    const user = userEvent.setup();
    renderGate();

    expect(await screen.findByTestId('demo-copy-unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Private project data')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry setup' }));

    expect(await screen.findByText('Private project data')).toBeInTheDocument();
    expect(screen.getByTestId('private-demo-banner')).toHaveTextContent('Planning only');
    expect(retryDemoShowcaseCopyMock).toHaveBeenCalledWith('csrf-demo');
    expect(screen.getByTestId('gate-location')).toHaveTextContent('/dashboard');
  });

  it('polls pending status and opens the ready private project after one admission', async () => {
    getDemoShowcaseCopyMock
      .mockResolvedValueOnce({ state: 'pending', projectId: null, retryAllowed: false, workspaceMode: null, capabilities: null })
      .mockResolvedValueOnce({ state: 'ready', projectId: '11111111-1111-4111-8111-111111111111', retryAllowed: false, workspaceMode: 'planning', capabilities: { planning: true, fileAccess: false } });
    renderInitialDemoEntry();

    expect(await screen.findByTestId('demo-copy-unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Private project data')).not.toBeInTheDocument();
    expect(await screen.findByText('Private project data')).toBeInTheDocument();
    expect(screen.getByTestId('gate-location')).toHaveTextContent('/projects/11111111-1111-4111-8111-111111111111');
    expect(screen.getByTestId('private-demo-banner')).toBeInTheDocument();
    expect(getDemoShowcaseCopyMock).toHaveBeenCalledTimes(2);
  });
});
