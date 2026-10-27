import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppSelector } from '@/app/store/hooks';
import { selectPrincipal, userSessionReducer } from '@/entities/user-session';
import { DemoEntryAction } from '@/features/auth/ui/DemoEntryAction';

const mocks = vi.hoisted(() => ({
  getAvailability: vi.fn(),
  createSession: vi.fn(),
  createKey: vi.fn(),
  getCurrentSession: vi.fn()
}));

vi.mock('@/entities/demo', () => ({
  createDemoAdmissionKey: mocks.createKey,
  createDemoSession: mocks.createSession,
  getDemoAvailability: mocks.getAvailability
}));

vi.mock('@/features/auth/api/auth-api', () => ({ getCurrentSession: mocks.getCurrentSession }));

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <><output data-testid="location-probe">{location.pathname}</output><output data-testid="location-state">{JSON.stringify(location.state)}</output></>;
}

function DemoLanding(): React.JSX.Element {
  const principal = useAppSelector(selectPrincipal);
  return <h1>{principal?.displayName ?? 'No active session'}</h1>;
}

function renderAction(): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer } });
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<><DemoEntryAction /><LocationProbe /></>} />
          <Route path="/dashboard" element={<><DemoLanding /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </Provider>
  );
}

describe('DemoEntryAction', () => {
  beforeEach(() => {
    mocks.getAvailability.mockReset();
    mocks.createSession.mockReset();
    mocks.createKey.mockReset();
    mocks.getCurrentSession.mockReset();
    mocks.createKey.mockReturnValue('a'.repeat(43));
  });

  it('fails closed when the server says no showcase is available', async () => {
    mocks.getAvailability.mockResolvedValue({ available: false });
    renderAction();

    expect(await screen.findByTestId('demo-unavailable-message')).toHaveTextContent('Demo is unavailable right now.');
    expect(screen.getByTestId('try-demo-button')).toBeDisabled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('does not treat a status-only replay as a demo session', async () => {
    mocks.getAvailability.mockResolvedValue({ available: true });
    mocks.createSession.mockResolvedValue({ state: 'ready' });
    mocks.createKey.mockReturnValueOnce('a'.repeat(43)).mockReturnValueOnce('b'.repeat(43));
    const user = userEvent.setup();
    renderAction();
    const button = await screen.findByTestId('try-demo-button');
    await waitFor(() => expect(button).toBeEnabled());

    await user.click(button);

    expect(await screen.findByTestId('demo-entry-error')).toHaveTextContent('could not be resumed in this browser');
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/login');
    expect(mocks.createSession).toHaveBeenCalledWith('a'.repeat(43));
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(2));
    expect(mocks.createSession).toHaveBeenNthCalledWith(2, 'b'.repeat(43));
  });

  it('reuses the admission key after an ambiguous network failure', async () => {
    mocks.getAvailability.mockResolvedValue({ available: true });
    mocks.createSession.mockRejectedValueOnce(new Error('network failure')).mockResolvedValue({ state: 'ready' });
    const user = userEvent.setup();
    renderAction();
    const button = await screen.findByTestId('try-demo-button');
    await waitFor(() => expect(button).toBeEnabled());

    await user.click(button);
    expect(await screen.findByTestId('demo-entry-error')).toBeInTheDocument();
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(2));
    expect(mocks.createSession).toHaveBeenNthCalledWith(1, 'a'.repeat(43));
    expect(mocks.createSession).toHaveBeenNthCalledWith(2, 'a'.repeat(43));
  });

  it('opens a private workspace only after receiving the full demo session', async () => {
    mocks.getAvailability.mockResolvedValue({ available: true });
    mocks.createSession.mockResolvedValue({
      state: 'ready',
      principal: { id: 'demo-owner', displayName: 'Demo workspace', accountKind: 'demo', role: 'user' },
      csrfToken: 'csrf-demo',
      expiresAt: '2026-10-20T00:00:00.000Z'
    });
    const user = userEvent.setup();
    renderAction();
    const button = await screen.findByTestId('try-demo-button');
    await waitFor(() => expect(button).toBeEnabled());

    await user.click(button);

    expect(await screen.findByRole('heading', { name: 'Demo workspace' })).toBeInTheDocument();
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/dashboard');
    expect(screen.getByTestId('location-state')).toHaveTextContent('"demoAdmissionEntry":true');
  });
});
