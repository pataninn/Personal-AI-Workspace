import { describe, expect, it } from 'vitest';

import {
  sessionAuthenticated,
  sessionCleared,
  userSessionReducer
} from '@/entities/user-session/model/slice';

describe('userSessionReducer', () => {
  it('keeps only the session snapshot needed by the app after authentication', () => {
    const state = userSessionReducer(
      undefined,
      sessionAuthenticated({
        principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const },
        csrfToken: 'csrf-value',
        expiresAt: '2026-09-13T00:00:00.000Z'
      })
    );

    expect(state).toEqual({
      status: 'authenticated',
      principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const },
      csrfToken: 'csrf-value',
      expiresAt: '2026-09-13T00:00:00.000Z',
      errorCode: null
    });
    expect(state).not.toHaveProperty('password');
    expect(state).not.toHaveProperty('sessionToken');
  });

  it('clears principal and CSRF state on logout', () => {
    const authenticated = userSessionReducer(
      undefined,
      sessionAuthenticated({
        principal: { id: 'user-1', displayName: 'Local user', accountKind: 'regular' as const, role: 'user' as const },
        csrfToken: 'csrf-value',
        expiresAt: '2026-09-13T00:00:00.000Z'
      })
    );

    expect(userSessionReducer(authenticated, sessionCleared('signed-out'))).toEqual({
      status: 'unauthenticated',
      principal: null,
      csrfToken: null,
      expiresAt: null,
      errorCode: 'signed-out'
    });
  });
});
