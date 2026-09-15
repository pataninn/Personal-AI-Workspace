import { configureStore } from '@reduxjs/toolkit';

import { userSessionReducer } from '@/entities/user-session';
import { projectReducer } from '@/entities/project';

export const store = configureStore({
  reducer: {
    userSession: userSessionReducer,
    project: projectReducer
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
