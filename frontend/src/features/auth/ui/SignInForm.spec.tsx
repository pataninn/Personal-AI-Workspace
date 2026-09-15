import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider } from 'react-redux';

import { userSessionReducer } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { SignInForm } from '@/features/auth/ui/SignInForm';

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));

vi.mock('@/features/auth/api/auth-api', () => ({
  signIn: signInMock
}));

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location-probe">{location.pathname}</output>;
}

function renderForm(initialEntry = '/login'): void {
  const store = configureStore({ reducer: { userSession: userSessionReducer } });
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <SignInForm />
        <LocationProbe />
      </MemoryRouter>
    </Provider>
  );
}

describe('SignInForm', () => {
  beforeEach(() => {
    signInMock.mockReset();
  });

  it('returns focus to the labelled password field when submitted empty', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter your local password.');
    expect(screen.getByLabelText('Local password')).toHaveFocus();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('shows a generic invalid-credential message without navigating', async () => {
    signInMock.mockRejectedValue(new ApiClientError(401, 'INVALID_CREDENTIALS', 'server detail'));
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Local password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('login-error-message')).toHaveTextContent(
      'That password was not accepted. Check it and try again.'
    );
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/login');
    expect(screen.getByLabelText('Local password')).toHaveValue('wrong-password');
  });

  it('rejects whitespace-only passwords and keeps focus on the invalid field', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Local password'), '   ');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter your local password.');
    expect(screen.getByLabelText('Local password')).toHaveFocus();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('rejects passwords over 1024 characters before making a request', async () => {
    const user = userEvent.setup();
    renderForm();

    fireEvent.change(screen.getByLabelText('Local password'), { target: { value: 'a'.repeat(1025) } });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a password between 1 and 1024 characters.');
    expect(screen.getByLabelText('Local password')).toHaveFocus();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('maps server validation errors to safe retry copy', async () => {
    signInMock.mockRejectedValue(new ApiClientError(400, 'VALIDATION_ERROR', 'server detail'));
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Local password'), 'valid-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('login-error-message')).toHaveTextContent(
      'Enter a valid local password and try again.'
    );
  });

  it('dispatches the non-secret session snapshot and navigates after success', async () => {
    signInMock.mockResolvedValue({
      principal: { id: 'user-1', displayName: 'Local user' },
      csrfToken: 'csrf-value',
      expiresAt: '2026-09-13T00:00:00.000Z'
    });
    const user = userEvent.setup();
    renderForm('/login?returnTo=%2Fdashboard');

    await user.type(screen.getByLabelText('Local password'), 'correct-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('login-status-message')).toHaveTextContent(
      'Signed in. Loading your workspace.'
    );
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/dashboard');
    expect(signInMock).toHaveBeenCalledWith('correct-password');
  });
});
