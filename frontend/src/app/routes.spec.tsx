import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ProtectedRoute, router } from '@/app/routes';
import { userSessionReducer } from '@/entities/user-session';
import { SignInForm } from '@/features/auth/ui/SignInForm';

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="route-location">{`${location.pathname}${location.search}`}</output>;
}

function routePaths(routes: typeof router.routes): string[] {
  return routes.flatMap((route) => [route.path ?? '', ...routePaths(route.children ?? [])]);
}

describe('application route registration', () => {
  it('adds planning chat while keeping existing project conversation routes', () => {
    const paths = routePaths(router.routes);

    expect(paths).toContain('projects/:projectId/planning-chat');
    expect(paths).toContain('projects/:projectId/conversations');
    expect(paths).toContain('projects/:projectId/conversations/:conversationId');
  });
});

describe('ProtectedRoute', () => {
  it('redirects an expired session with a safe return path and visible notice', async () => {
    const store = configureStore({
      reducer: { userSession: userSessionReducer },
      preloadedState: {
        userSession: {
          status: 'unauthenticated' as const,
          principal: null,
          csrfToken: null,
          expiresAt: null,
          errorCode: 'SESSION_UNAUTHENTICATED'
        }
      }
    });

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/dashboard?tab=recent']}>
          <Routes>
            <Route element={<ProtectedRoute />}>
              <Route path="/dashboard" element={<h1>Workspace</h1>} />
            </Route>
            <Route path="/login" element={<SignInForm />} />
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </Provider>
    );

    expect(await screen.findByText('Your local session expired. Sign in again to continue.')).toBeInTheDocument();
    expect(screen.getByTestId('route-location')).toHaveTextContent(
      '/login?reason=session-expired&returnTo=%2Fdashboard%3Ftab%3Drecent'
    );
    expect(screen.queryByRole('heading', { name: 'Workspace' })).not.toBeInTheDocument();
  });
});
