import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { SessionSnapshot, UserSessionState } from '@/entities/user-session/model/types';

const initialState: UserSessionState = {
  status: 'unknown',
  principal: null,
  csrfToken: null,
  expiresAt: null,
  errorCode: null
};

const userSessionSlice = createSlice({
  name: 'userSession',
  initialState,
  reducers: {
    sessionCheckStarted(state): void {
      state.status = 'loading';
      state.errorCode = null;
    },
    sessionAuthenticated(state, action: PayloadAction<SessionSnapshot>): void {
      state.status = 'authenticated';
      state.principal = action.payload.principal;
      state.csrfToken = action.payload.csrfToken;
      state.expiresAt = action.payload.expiresAt;
      state.errorCode = null;
    },
    sessionUnauthenticated(state, action: PayloadAction<string | undefined>): void {
      state.status = 'unauthenticated';
      state.principal = null;
      state.csrfToken = null;
      state.expiresAt = null;
      state.errorCode = action.payload ?? null;
    },
    sessionBootstrapFailed(state, action: PayloadAction<string>): void {
      state.status = 'error';
      state.principal = null;
      state.csrfToken = null;
      state.expiresAt = null;
      state.errorCode = action.payload;
    },
    sessionCleared(state, action: PayloadAction<string | undefined>): void {
      state.status = 'unauthenticated';
      state.principal = null;
      state.csrfToken = null;
      state.expiresAt = null;
      state.errorCode = action.payload ?? null;
    }
  }
});

export const {
  sessionAuthenticated,
  sessionBootstrapFailed,
  sessionCheckStarted,
  sessionCleared,
  sessionUnauthenticated
} = userSessionSlice.actions;

export const userSessionReducer = userSessionSlice.reducer;
