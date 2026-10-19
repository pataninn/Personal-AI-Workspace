import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider } from 'react-redux';

import { userSessionReducer } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';
import { SignInForm } from '@/features/auth/ui/SignInForm';

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  getDemoAvailability: vi.fn(),
  createDemoAdmissionKey: vi.fn(),
  createDemoSession: vi.fn()
}));

vi.mock('@/features/auth/api/auth-api', () => ({
  signIn: mocks.signIn,
  getCurrentSession: vi.fn()
}));

vi.mock('@/entities/demo', () => ({
  getDemoAvailability: mocks.getDemoAvailability,
  createDemoAdmissionKey: mocks.createDemoAdmissionKey,
  createDemoSession: mocks.createDemoSession
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
    mocks.signIn.mockReset();
    mocks.getDemoAvailability.mockReset().mockResolvedValue({ available: false });
    mocks.createDemoAdmissionKey.mockReset();
    mocks.createDemoSession.mockReset();
  });

  it('focuses the first required field when submitted empty', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter your account identifier.');
    expect(screen.getByLabelText('Account identifier')).toHaveFocus();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('shows a generic invalid-credential message without navigating', async () => {
    mocks.signIn.mockRejectedValue(new ApiClientError(401, 'INVALID_CREDENTIALS', 'server detail'));
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Account identifier'), 'owner');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('login-error-message')).toHaveTextContent(
      'That account identifier or password was not accepted. Check both and try again.'
    );
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/login');
    expect(screen.getByLabelText('Account identifier')).toHaveValue('owner');
    expect(screen.getByLabelText('Password')).toHaveValue('wrong-password');
  });

  it('rejects whitespace-only passwords and keeps focus on the invalid field', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Account identifier'), 'owner');
    await user.type(screen.getByLabelText('Password'), '   ');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter your password.');
    expect(screen.getByLabelText('Password')).toHaveFocus();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('rejects passwords over 1024 characters before making a request', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Account identifier'), 'owner');
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a'.repeat(1025) } });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a password between 1 and 1024 characters.');
    expect(screen.getByLabelText('Password')).toHaveFocus();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('maps server validation errors to safe retry copy', async () => {
    mocks.signIn.mockRejectedValue(new ApiClientError(400, 'VALIDATION_ERROR', 'server detail'));
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText('Account identifier'), 'owner');
    await user.type(screen.getByLabelText('Password'), 'valid-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('login-error-message')).toHaveTextContent(
      'Check the account identifier and password format, then try again.'
    );
  });

  it('dispatches the non-secret session snapshot and navigates after success', async () => {
    mocks.signIn.mockResolvedValue({
      principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular', role: 'admin' },
      csrfToken: 'csrf-value',
      expiresAt: '2026-09-13T00:00:00.000Z'
    });
    const user = userEvent.setup();
    renderForm('/login?returnTo=%2Fdashboard');

    await user.type(screen.getByLabelText('Account identifier'), ' OWNER ');
    await user.type(screen.getByLabelText('Password'), 'correct-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByTestId('login-status-message')).toHaveTextContent(
      'Signed in. Loading your workspace.'
    );
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/dashboard');
    expect(mocks.signIn).toHaveBeenCalledWith(' OWNER ', 'correct-password');
  });
});
