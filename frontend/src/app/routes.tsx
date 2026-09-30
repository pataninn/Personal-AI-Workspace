import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom';

import { App } from '@/app/App';
import { AppShell } from '@/widgets/app-shell';
import { DashboardPage } from '@/pages/dashboard';
import { ProjectWorkspacePage } from '@/pages/project-workspace';
import { ProjectMemoryPage } from '@/pages/project-memory';
import { ProjectTasksPage } from '@/pages/project-tasks';
import { ProjectActivityPage } from '@/pages/project-activity';
import { ProjectFileHistoryPage } from '@/pages/project-file-history';
import { LoginPage } from '@/pages/login';
import { NotFoundPage } from '@/pages/not-found';
import { selectSessionErrorCode, selectSessionStatus } from '@/entities/user-session';
import { useAppSelector } from '@/app/store/hooks';
import { getSafeReturnTo, loginPath } from '@/shared/lib/navigation';

function RootRedirect(): React.JSX.Element {
  const status = useAppSelector(selectSessionStatus);
  return status === 'authenticated' ? <Navigate to="/dashboard" replace /> : <Navigate to="/login" replace />;
}

function PublicOnlyRoute(): React.JSX.Element {
  const status = useAppSelector(selectSessionStatus);
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const returnTo = getSafeReturnTo(params.get('returnTo'));
  return status === 'authenticated' ? <Navigate to={returnTo ?? '/dashboard'} replace /> : <LoginPage />;
}

export function ProtectedRoute(): React.JSX.Element {
  const status = useAppSelector(selectSessionStatus);
  const errorCode = useAppSelector(selectSessionErrorCode);
  const location = useLocation();
  if (status !== 'authenticated') {
    const reason = errorCode === 'SESSION_UNAUTHENTICATED' ? 'session-expired' : undefined;
    return <Navigate to={loginPath(reason, `${location.pathname}${location.search}`)} replace />;
  }
  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <RootRedirect /> },
      { path: 'login', element: <PublicOnlyRoute /> },
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <AppShell />,
            children: [
              { path: 'dashboard', element: <DashboardPage /> },
              { path: 'projects/:projectId', element: <ProjectWorkspacePage /> },
              { path: 'projects/:projectId/memory', element: <ProjectMemoryPage /> },
              { path: 'projects/:projectId/tasks', element: <ProjectTasksPage /> },
              { path: 'projects/:projectId/activity', element: <ProjectActivityPage /> },
              { path: 'projects/:projectId/file-history', element: <ProjectFileHistoryPage /> },
              { path: 'projects/:projectId/conversations', element: <ProjectWorkspacePage /> },
              { path: 'projects/:projectId/conversations/:conversationId', element: <ProjectWorkspacePage /> },
              { path: '*', element: <NotFoundPage /> }
            ]
          }
        ]
      }
    ]
  }
]);
