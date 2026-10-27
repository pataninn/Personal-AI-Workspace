import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';

import { sessionCleared, selectCsrfToken, selectPrincipal } from '@/entities/user-session';
import { signOut, AUTH_COPY } from '@/features/auth';
import { RemoveProjectDialog, RenameProjectDialog, useProjectListLoader } from '@/features/project-management';
import { ProjectHeader, ProjectNavigation } from '@/widgets/project-navigation';
import { selectProjects } from '@/entities/project';
import type { ProjectSnapshot } from '@/entities/project';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { ApiClientError } from '@/shared/api';
import { loginPath } from '@/shared/lib/navigation';
import {
  Alert,
  Button,
  Icon,
  DrawerContent,
  DrawerRoot,
  DrawerTitle,
  DrawerTrigger
} from '@/shared/ui';
import { HomeAsk } from '@/widgets/app-shell/HomeAsk';

export interface AppShellOutletContext {
  readonly registerHomeSummaryRefresh: (refresh: (() => void) | null) => void;
  readonly registerTaskEditorExitGuard?: (guard: (() => Promise<boolean>) | null) => void;
}

export function AppShell(): React.JSX.Element {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const principal = useAppSelector(selectPrincipal);
  const csrfToken = useAppSelector(selectCsrfToken);
  const mainRef = useRef<HTMLElement>(null);
  const homeSummaryRefreshRef = useRef<(() => void) | null>(null);
  const taskEditorExitGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProjectSnapshot | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectSnapshot | null>(null);
  useProjectListLoader();
  const displayName = principal?.displayName || 'Local user';
  const registerHomeSummaryRefresh = useCallback((refresh: (() => void) | null): void => {
    homeSummaryRefreshRef.current = refresh;
  }, []);
  const requestHomeSummaryRefresh = useCallback((): void => {
    homeSummaryRefreshRef.current?.();
  }, []);
  const registerTaskEditorExitGuard = useCallback((guard: (() => Promise<boolean>) | null): void => {
    taskEditorExitGuardRef.current = guard;
  }, []);

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.pathname]);

  async function handleSignOut(): Promise<void> {
    if (isSigningOut || !csrfToken) {
      return;
    }
    const canSignOut = await (taskEditorExitGuardRef.current?.() ?? Promise.resolve(true));
    if (!canSignOut) return;
    setIsSigningOut(true);
    setLogoutError(false);
    try {
      await signOut(csrfToken);
      dispatch(sessionCleared('signed-out'));
      navigate(loginPath('signed-out'), { replace: true });
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.statusCode === 401) {
        dispatch(sessionCleared('signed-out'));
        navigate(loginPath('signed-out'), { replace: true });
      } else {
        setLogoutError(true);
      }
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="app-shell-layout" data-testid="app-shell">
      <aside className="desktop-sidebar" aria-label="Primary navigation">
        <BrandLink />
        <WorkspaceNavigation currentPath={location.pathname} />
      </aside>
      <div className="shell-content">
        <header className="app-shell-header" data-testid="app-shell-header">
          <ShellBreadcrumb />
          <div className="mobile-header-start">
            <DrawerRoot open={drawerOpen} onOpenChange={setDrawerOpen}>
              <DrawerTrigger asChild>
                <Button variant="ghost" data-testid="mobile-nav-trigger" aria-label="Open navigation" aria-controls="mobile-nav-drawer">
                  <span aria-hidden="true">☰</span>
                  <span>Menu</span>
                </Button>
              </DrawerTrigger>
              <DrawerContent data-testid="mobile-nav-drawer" aria-describedby={undefined}>
                <DrawerTitle className="sr-only">Navigation</DrawerTitle>
                <WorkspaceNavigation currentPath={location.pathname} onNavigate={() => setDrawerOpen(false)} />
              </DrawerContent>
            </DrawerRoot>
            <BrandLink />
          </div>
          <div className="account-area">
            <AccountMenu
              displayName={displayName}
              isAdmin={principal?.accountKind === 'regular' && principal.role === 'admin'}
              isSigningOut={isSigningOut}
              logoutError={logoutError}
              onSignOut={handleSignOut}
            />
          </div>
        </header>
        <main ref={mainRef} className={`app-shell-main${principal ? ' home-ask-shell-main' : ''}`} data-testid="app-shell-main" tabIndex={-1}>
          <ProjectHeader onRemove={setRemoveTarget} onRename={setRenameTarget} />
          <Suspense fallback={<p role="status" className="p-6">Loading page...</p>}>
            <Outlet context={{ registerHomeSummaryRefresh, registerTaskEditorExitGuard } satisfies AppShellOutletContext} />
          </Suspense>
        </main>
      </div>
      <HomeAsk onSummaryRefreshRequested={requestHomeSummaryRefresh} />
      <RemoveProjectDialog project={removeTarget} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }} onRemoved={() => { setRemoveTarget(null); navigate('/dashboard'); }} />
      {renameTarget ? <RenameProjectDialog key={renameTarget.id} project={renameTarget} onClose={() => setRenameTarget(null)} /> : null}
    </div>
  );
}

const ACCOUNT_MENU_ID = 'account-menu';
const ACCOUNT_MENU_ITEM_ID = 'account-menu-sign-out';

interface AccountMenuProps {
  readonly displayName: string;
  readonly isAdmin: boolean;
  readonly isSigningOut: boolean;
  readonly logoutError: boolean;
  readonly onSignOut: () => void;
}

function AccountMenu({ displayName, isAdmin, isSigningOut, logoutError, onSignOut }: AccountMenuProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function closeWhenPointerLeaves(event: PointerEvent): void {
      if (isSigningOut) {
        return;
      }
      if (!isEventInside(containerRef.current, event.target)) {
        setIsOpen(false);
      }
    }

    function closeWhenFocusLeaves(event: FocusEvent): void {
      if (isSigningOut) {
        return;
      }
      if (!isEventInside(containerRef.current, event.target)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('pointerdown', closeWhenPointerLeaves);
    document.addEventListener('focusin', closeWhenFocusLeaves);
    if (!isSigningOut) {
      menuItemRef.current?.focus();
    }

    return () => {
      document.removeEventListener('pointerdown', closeWhenPointerLeaves);
      document.removeEventListener('focusin', closeWhenFocusLeaves);
    };
  }, [isOpen, isSigningOut]);

  useEffect(() => {
    if (isOpen && logoutError && !isSigningOut) {
      menuItemRef.current?.focus();
    }
  }, [isOpen, isSigningOut, logoutError]);

  function closeMenu(restoreFocus: boolean): void {
    setIsOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIsOpen(true);
    }
    if (event.key === 'Escape' && isOpen && !isSigningOut) {
      event.preventDefault();
      closeMenu(true);
    }
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' && !isSigningOut) {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      menuItemRef.current?.focus();
    }
  }

  function handleMenuItemClick(): void {
    onSignOut();
  }

  return (
    <div ref={containerRef} className="account-menu-container">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        data-testid="account-menu-trigger"
        aria-label={`Account menu for ${displayName}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={ACCOUNT_MENU_ID}
        onClick={() => {
          if (!isSigningOut) {
            setIsOpen((open) => !open);
          }
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <Icon name="user" size={16} /><span>Account</span>
      </Button>
      {isOpen ? (
        <div
          id={ACCOUNT_MENU_ID}
          className="account-menu"
          data-testid="account-menu"
          role="menu"
          aria-label="Account menu"
          aria-orientation="vertical"
          onKeyDown={handleMenuKeyDown}
        >
          <div className="account-menu-label" role="presentation">{displayName}</div>
          <div className="account-menu-separator" role="separator" />
          <Link className="account-menu-item" role="menuitem" tabIndex={0} to="/usage" onClick={() => closeMenu(false)}>Usage</Link>
          {isAdmin ? <Link className="account-menu-item" role="menuitem" tabIndex={0} to="/admin" onClick={() => closeMenu(false)}>Admin portal</Link> : null}
          <div className="account-menu-feedback" role="group" aria-label="Sign out status">
            {isSigningOut ? <p className="logout-status" data-testid="logout-status-message" role="status" aria-live="polite">Signing out…</p> : null}
            {logoutError ? <Alert tone="error" data-testid="logout-error-message">{AUTH_COPY.logoutFailed}</Alert> : null}
          </div>
          <button
            ref={menuItemRef}
            id={ACCOUNT_MENU_ITEM_ID}
            className="account-menu-item"
            data-testid="logout-button"
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={isSigningOut}
            aria-busy={isSigningOut}
            onClick={handleMenuItemClick}
          >
            {isSigningOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function isEventInside(container: HTMLElement | null, target: EventTarget | null): boolean {
  return target instanceof Node && container?.contains(target) === true;
}

function BrandLink(): React.JSX.Element {
  return <Link className="brand-link" to="/dashboard"><span>Personal AI<br />Workspace</span></Link>;
}

function ShellBreadcrumb(): React.JSX.Element {
  const { projectId } = useParams();
  const { pathname } = useLocation();
  const project = useAppSelector(selectProjects).find((candidate) => candidate.id === projectId);
  const section = pathname.split('/').at(-1);
  const labels: Record<string, string> = { activity: 'Activity', memory: 'Memory', context: 'Context', tasks: 'Tasks', 'file-history': 'History', admin: 'Admin portal', usage: 'Usage', automations: 'Automations' };
  const title = pathname === '/tasks' ? 'All tasks' : pathname.startsWith('/tasks/') ? 'Task details' : projectId && section && labels[section] ? labels[section] : project?.name ?? 'Home';
  return <nav className="shell-breadcrumb" aria-label="Current page"><strong>{title}</strong></nav>;
}

function WorkspaceNavigation({ currentPath, onNavigate }: { readonly currentPath: string; readonly onNavigate?: () => void }): React.JSX.Element {
  const principal = useAppSelector(selectPrincipal);
  return (
    <nav className="shell-nav" data-testid="app-shell-nav" aria-label="Primary navigation">
      <NavLink
        className={({ isActive }) => `shell-nav-link${isActive ? ' is-active' : ''}`}
        data-testid="workspace-nav-link"
        to="/dashboard"
        aria-current={currentPath === '/dashboard' ? 'page' : undefined}
        onClick={onNavigate}
      >
        <Icon name="home" /><span>Home</span>
      </NavLink>
      <ProjectNavigation onNavigate={onNavigate} />
      <NavLink className={({ isActive }) => `shell-nav-link${isActive ? ' is-active' : ''}`} to="/automations" aria-current={currentPath === '/automations' ? 'page' : undefined} onClick={onNavigate}>
        <span>Automations</span>
      </NavLink>
      <NavLink className={({ isActive }) => `shell-nav-link${isActive ? ' is-active' : ''}`} to="/usage" aria-current={currentPath === '/usage' ? 'page' : undefined} onClick={onNavigate}>
        <span>Usage</span>
      </NavLink>
      {principal?.accountKind === 'regular' && principal.role === 'admin' ? <NavLink className={({ isActive }) => `shell-nav-link${isActive ? ' is-active' : ''}`} to="/admin" aria-current={currentPath === '/admin' ? 'page' : undefined} onClick={onNavigate}>
        <span>Admin portal</span>
      </NavLink> : null}
    </nav>
  );
}
