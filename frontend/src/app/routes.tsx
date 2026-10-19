import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom';

import { App } from '@/app/App';
import { AppShell } from '@/widgets/app-shell';
import { DashboardPage } from '@/pages/dashboard';
import { ProjectWorkspacePage } from '@/pages/project-workspace';
import { ProjectMemoryPage } from '@/pages/project-memory';
import { ProjectContextPage } from '@/pages/project-context';
import { ProjectTasksPage } from '@/pages/project-tasks';
import { ProjectActivityPage } from '@/pages/project-activity';
import { ProjectFileHistoryPage } from '@/pages/project-file-history';
import { WorkspacePlanningChatPage } from '@/pages/workspace-planning-chat';
import { AllTasksPage } from '@/pages/all-tasks';
import { TaskDetailPage } from '@/pages/task-detail';
import { LoginPage } from '@/pages/login';
import { NotFoundPage } from '@/pages/not-found';
import { ShowcasePage } from '@/pages/showcase';
import { AdminShowcasePage } from '@/pages/admin-showcase';
import { selectSessionErrorCode, selectSessionStatus } from '@/entities/user-session';
import { useAppSelector } from '@/app/store/hooks';
import { getSafeReturnTo, loginPath } from '@/shared/lib/navigation';
import { DemoContentGate } from '@/widgets/demo-session-route';

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
      { path: 'showcase', element: <ShowcasePage /> },
      { path: 'login', element: <PublicOnlyRoute /> },
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <DemoContentGate><Outlet /></DemoContentGate>,
            children: [
              {
                element: <AppShell />,
                children: [
                  { path: 'dashboard', element: <DashboardPage /> },
                  { path: 'tasks', element: <AllTasksPage /> },
                  { path: 'tasks/:taskId', element: <TaskDetailPage /> },
                  { path: 'projects/:projectId', element: <ProjectWorkspacePage /> },
                  { path: 'projects/:projectId/memory', element: <ProjectMemoryPage /> },
                  { path: 'projects/:projectId/context', element: <ProjectContextPage /> },
                  { path: 'projects/:projectId/tasks', element: <ProjectTasksPage /> },
                  { path: 'projects/:projectId/activity', element: <ProjectActivityPage /> },
                  { path: 'projects/:projectId/file-history', element: <ProjectFileHistoryPage /> },
                  { path: 'projects/:projectId/planning-chat', element: <WorkspacePlanningChatPage /> },
                  { path: 'projects/:projectId/conversations', element: <ProjectWorkspacePage /> },
                  { path: 'projects/:projectId/conversations/:conversationId', element: <ProjectWorkspacePage /> },
                  { path: '*', element: <NotFoundPage /> }
                ]
              },
              { path: 'admin/showcase', element: <AdminShowcasePage /> }
            ]
          }
        ]
      }
    ]
  }
]);
