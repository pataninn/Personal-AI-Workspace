import { combineReducers, configureStore, isAction, type Middleware, type UnknownAction } from '@reduxjs/toolkit';

import { userSessionReducer } from '@/entities/user-session';
import { projectReducer, projectSessionChanged } from '@/entities/project';
import { advanceRequestSessionGeneration } from '@/shared/api';

const combinedReducer = combineReducers({
    userSession: userSessionReducer,
    project: projectReducer
});

export type RootState = ReturnType<typeof combinedReducer>;

function sessionChanged(previous: RootState['userSession'], next: RootState['userSession']): boolean {
  return previous.principal?.id !== next.principal?.id || previous.csrfToken !== next.csrfToken;
}

const sessionBoundary: Middleware<object, RootState> = (api) => (next) => (action) => {
  if (isAction(action) && sessionChanged(api.getState().userSession, userSessionReducer(api.getState().userSession, action))) {
    advanceRequestSessionGeneration();
  }
  return next(action);
};

/** Session transitions fence all prior project requests, including a later return to the same owner. */
export function rootReducer(state: RootState | undefined, action: UnknownAction): RootState {
  const next = combinedReducer(state, action);
  if (state && sessionChanged(state.userSession, next.userSession)) {
    return { ...next, project: projectReducer(next.project, projectSessionChanged()) };
  }
  return next;
}

export const createAppStore = () => configureStore({ reducer: rootReducer, middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(sessionBoundary) });
export const store = createAppStore();
export type AppDispatch = typeof store.dispatch;
