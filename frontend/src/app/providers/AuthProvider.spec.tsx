import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '@/app/providers/AuthProvider';
import { userSessionReducer } from '@/entities/user-session';
import { ApiClientError } from '@/shared/api';

const { getCurrentSessionMock } = vi.hoisted(() => ({ getCurrentSessionMock: vi.fn() }));

vi.mock('@/features/auth/api/auth-api', () => ({
  getCurrentSession: getCurrentSessionMock
}));

function createTestStore() {
  return configureStore({ reducer: { userSession: userSessionReducer } });
}

function renderProvider(): ReturnType<typeof createTestStore> {
  const store = createTestStore();
  render(
    <Provider store={store}>
      <AuthProvider>
        <p data-testid="protected-child">Protected content</p>
      </AuthProvider>
    </Provider>
  );
  return store;
}

describe('AuthProvider', () => {
  beforeEach(() => {
    getCurrentSessionMock.mockReset();
  });

  it('blocks children during bootstrap and exposes only the non-secret session snapshot', async () => {
    getCurrentSessionMock.mockResolvedValue({
      principal: { id: 'user-1', displayName: 'Local user' },
      csrfToken: 'csrf-value',
      expiresAt: '2026-09-13T00:00:00.000Z'
    });
    const store = renderProvider();

    expect(screen.getByTestId('session-bootstrap-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-child')).not.toBeInTheDocument();
    expect(await screen.findByTestId('protected-child')).toBeInTheDocument();
    expect(store.getState().userSession).toMatchObject({ status: 'authenticated', principal: { id: 'user-1' } });
    expect(store.getState().userSession).not.toHaveProperty('password');
    expect(store.getState().userSession).not.toHaveProperty('sessionToken');
  });

  it('fails closed on session network errors and retries explicitly', async () => {
    getCurrentSessionMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        principal: { id: 'user-1', displayName: 'Local user' },
        csrfToken: 'csrf-value',
        expiresAt: '2026-09-13T00:00:00.000Z'
      });
    renderProvider();

    expect(await screen.findByTestId('session-bootstrap-error')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-child')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('protected-child')).toBeInTheDocument();
    expect(getCurrentSessionMock).toHaveBeenCalledTimes(2);
  });

  it('transitions to unauthenticated after a definitive 401 without treating it as a bootstrap failure', async () => {
    getCurrentSessionMock.mockRejectedValue(new ApiClientError(401, 'SESSION_UNAUTHENTICATED', 'unauthenticated'));
    const store = renderProvider();

    expect(await screen.findByTestId('protected-child')).toBeInTheDocument();
    expect(store.getState().userSession.status).toBe('unauthenticated');
    expect(store.getState().userSession.errorCode).toBe('SESSION_UNAUTHENTICATED');
    expect(screen.queryByTestId('session-bootstrap-error')).not.toBeInTheDocument();
  });
});
