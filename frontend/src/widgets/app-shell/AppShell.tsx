import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';

import { sessionCleared, selectCsrfToken, selectPrincipal } from '@/entities/user-session';
import { signOut, AUTH_COPY } from '@/features/auth';
import { RemoveProjectDialog, useProjectListLoader } from '@/features/project-management';
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
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerRoot,
  DrawerTitle,
  DrawerTrigger
} from '@/shared/ui';

export function AppShell(): React.JSX.Element {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const principal = useAppSelector(selectPrincipal);
  const csrfToken = useAppSelector(selectCsrfToken);
  const mainRef = useRef<HTMLElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProjectSnapshot | null>(null);
  useProjectListLoader();
  const displayName = principal?.displayName || 'Local user';

  useEffect(() => {
    mainRef.current?.focus();
  }, [location.pathname]);

  async function handleSignOut(): Promise<void> {
    if (isSigningOut || !csrfToken) {
      return;
    }
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
              <DrawerContent data-testid="mobile-nav-drawer" aria-describedby="mobile-nav-description">
                <DrawerTitle>Navigation</DrawerTitle>
                <DrawerDescription id="mobile-nav-description">Move between the protected workspace areas.</DrawerDescription>
                <DrawerClose asChild>
                  <Button variant="ghost" data-testid="mobile-nav-close-button">Close menu</Button>
                </DrawerClose>
                <nav aria-label="Primary navigation"><WorkspaceNavigation currentPath={location.pathname} onNavigate={() => setDrawerOpen(false)} /></nav>
              </DrawerContent>
            </DrawerRoot>
            <BrandLink />
          </div>
          <div className="account-area">
            <AccountMenu
              displayName={displayName}
              isSigningOut={isSigningOut}
              logoutError={logoutError}
              onSignOut={handleSignOut}
            />
          </div>
        </header>
        <main ref={mainRef} className="app-shell-main" data-testid="app-shell-main" tabIndex={-1}>
          <ProjectHeader onRemove={setRemoveTarget} />
          <Outlet />
        </main>
      </div>
      <RemoveProjectDialog project={removeTarget} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }} onRemoved={() => { setRemoveTarget(null); navigate('/dashboard'); }} />
    </div>
  );
}

const ACCOUNT_MENU_ID = 'account-menu';
const ACCOUNT_MENU_ITEM_ID = 'account-menu-sign-out';

interface AccountMenuProps {
  readonly displayName: string;
  readonly isSigningOut: boolean;
  readonly logoutError: boolean;
  readonly onSignOut: () => void;
}

function AccountMenu({ displayName, isSigningOut, logoutError, onSignOut }: AccountMenuProps): React.JSX.Element {
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
  const labels: Record<string, string> = { activity: 'Activity', memory: 'Memory', context: 'Context', tasks: 'Tasks', 'file-history': 'History' };
  const title = projectId && section && labels[section] ? labels[section] : project?.name ?? 'Home';
  return <nav className="shell-breadcrumb" aria-label="Current page"><strong>{title}</strong></nav>;
}

function WorkspaceNavigation({ currentPath, onNavigate }: { readonly currentPath: string; readonly onNavigate?: () => void }): React.JSX.Element {
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
    </nav>
  );
}
