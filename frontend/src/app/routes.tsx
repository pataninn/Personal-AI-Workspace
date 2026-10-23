import { lazy } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom';

import { App } from '@/app/App';
import { AppShell } from '@/widgets/app-shell';
import { selectSessionErrorCode, selectSessionStatus } from '@/entities/user-session';
import { useAppSelector } from '@/app/store/hooks';
import { getSafeReturnTo, loginPath } from '@/shared/lib/navigation';
import { DemoContentGate } from '@/widgets/demo-session-route';

const DashboardPage = lazy(() => import('@/pages/dashboard').then((module) => ({ default: module.DashboardPage })));
const ProjectWorkspacePage = lazy(() => import('@/pages/project-workspace').then((module) => ({ default: module.ProjectWorkspacePage })));
const ProjectMemoryPage = lazy(() => import('@/pages/project-memory').then((module) => ({ default: module.ProjectMemoryPage })));
const ProjectContextPage = lazy(() => import('@/pages/project-context').then((module) => ({ default: module.ProjectContextPage })));
const ProjectTasksPage = lazy(() => import('@/pages/project-tasks').then((module) => ({ default: module.ProjectTasksPage })));
const ProjectActivityPage = lazy(() => import('@/pages/project-activity').then((module) => ({ default: module.ProjectActivityPage })));
const ProjectFileHistoryPage = lazy(() => import('@/pages/project-file-history').then((module) => ({ default: module.ProjectFileHistoryPage })));
const WorkspacePlanningChatPage = lazy(() => import('@/pages/workspace-planning-chat').then((module) => ({ default: module.WorkspacePlanningChatPage })));
const AllTasksPage = lazy(() => import('@/pages/all-tasks').then((module) => ({ default: module.AllTasksPage })));
const TaskDetailPage = lazy(() => import('@/pages/task-detail').then((module) => ({ default: module.TaskDetailPage })));
const LoginPage = lazy(() => import('@/pages/login').then((module) => ({ default: module.LoginPage })));
const NotFoundPage = lazy(() => import('@/pages/not-found').then((module) => ({ default: module.NotFoundPage })));
const ShowcasePage = lazy(() => import('@/pages/showcase').then((module) => ({ default: module.ShowcasePage })));
const AdminShowcasePage = lazy(() => import('@/pages/admin-showcase').then((module) => ({ default: module.AdminShowcasePage })));
const AdminPortalPage = lazy(() => import('@/pages/admin-portal').then((module) => ({ default: module.AdminPortalPage })));
const SkillsPage = lazy(() => import('@/pages/skills').then((module) => ({ default: module.SkillsPage })));
const UsagePage = lazy(() => import('@/pages/usage').then((module) => ({ default: module.UsagePage })));
const AutomationsPage = lazy(() => import('@/pages/automations').then((module) => ({ default: module.AutomationsPage })));

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
                  { path: 'admin', element: <AdminPortalPage /> },
                  { path: 'usage', element: <UsagePage /> },
                  { path: 'automations', element: <AutomationsPage /> },
                  { path: 'tasks', element: <AllTasksPage /> },
                  { path: 'tasks/:taskId', element: <TaskDetailPage /> },
                  { path: 'projects/:projectId', element: <ProjectWorkspacePage /> },
                  { path: 'projects/:projectId/memory', element: <ProjectMemoryPage /> },
                  { path: 'projects/:projectId/context', element: <ProjectContextPage /> },
                  { path: 'projects/:projectId/tasks', element: <ProjectTasksPage /> },
                  { path: 'projects/:projectId/activity', element: <ProjectActivityPage /> },
                  { path: 'projects/:projectId/file-history', element: <ProjectFileHistoryPage /> },
                  { path: 'projects/:projectId/skills', element: <SkillsPage /> },
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
