import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { userSessionReducer } from '@/entities/user-session';
import { AppShell } from '@/widgets/app-shell/AppShell';

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));

vi.mock('@/features/auth/api/auth-api', () => ({
  signOut: signOutMock
}));

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="shell-location">{location.pathname}</output>;
}

function renderShell() {
  const store = configureStore({
    reducer: { userSession: userSessionReducer },
    preloadedState: {
      userSession: {
        status: 'authenticated' as const,
        principal: { id: 'user-1', displayName: 'Pat' },
        csrfToken: 'csrf-value',
        expiresAt: '2026-09-13T00:00:00.000Z',
        errorCode: null
      }
    }
  });
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<AppShell />}>
            <Route index element={<h1>Workspace</h1>} />
          </Route>
          <Route path="/login" element={<h1>Login</h1>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </Provider>
  );
  return store;
}

describe('AppShell', () => {
  beforeEach(() => {
    signOutMock.mockReset();
  });

  it('renders the protected navigation and opens/closes the keyboard-accessible drawer', async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute('aria-current', 'page');
    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Move between the protected workspace areas.')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('opens the account menu from the keyboard and restores focus on Escape', async () => {
    const user = userEvent.setup();
    renderShell();

    const trigger = screen.getByRole('button', { name: 'Account menu for Pat' });
    trigger.focus();
    await user.keyboard('{Enter}');

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', 'account-menu');
    expect(screen.getByRole('menu', { name: 'Account menu' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Account menu' })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('revokes the session before navigating to the signed-out login state', async () => {
    signOutMock.mockResolvedValue(undefined);
    const store = renderShell();
    const user = userEvent.setup();

    const trigger = screen.getByRole('button', { name: 'Account menu for Pat' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(signOutMock).toHaveBeenCalledWith('csrf-value');
      expect(store.getState().userSession.status).toBe('unauthenticated');
      expect(screen.getByTestId('shell-location')).toHaveTextContent('/login');
    });
  });

  it('keeps the visible logout action mounted and prevents duplicate requests while pending', async () => {
    let resolveLogout: (() => void) | undefined;
    signOutMock.mockReturnValue(new Promise<void>((resolve) => {
      resolveLogout = resolve;
    }));
    const user = userEvent.setup();
    renderShell();

    const trigger = screen.getByRole('button', { name: 'Account menu for Pat' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const logoutButton = screen.getByRole('menuitem', { name: 'Sign out' });
    await user.click(logoutButton);

    expect(screen.getByRole('menu', { name: 'Account menu' })).toBeInTheDocument();
    expect(screen.getByTestId('logout-status-message')).toHaveTextContent('Signing out…');
    expect(screen.getByRole('menuitem', { name: 'Signing out…' })).toBeDisabled();
    await user.click(trigger);
    expect(signOutMock).toHaveBeenCalledTimes(1);

    resolveLogout?.();
    await waitFor(() => expect(screen.getByTestId('shell-location')).toHaveTextContent('/login'));
  });

  it('keeps the shell available when logout cannot be confirmed', async () => {
    signOutMock
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    renderShell();

    const trigger = screen.getByRole('button', { name: 'Account menu for Pat' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');

    expect(await screen.findByTestId('logout-error-message')).toHaveTextContent(
      'We could not confirm sign out. Try again.'
    );
    expect(screen.getByTestId('shell-location')).toHaveTextContent('/dashboard');
    const retryButton = screen.getByRole('menuitem', { name: 'Sign out' });
    expect(retryButton).toBeEnabled();
    expect(retryButton).toHaveFocus();

    await user.click(retryButton);
    await waitFor(() => {
      expect(signOutMock).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('shell-location')).toHaveTextContent('/login');
    });
  });
});
