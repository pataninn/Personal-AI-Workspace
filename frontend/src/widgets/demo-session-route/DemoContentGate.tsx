import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { getDemoShowcaseCopy, retryDemoShowcaseCopy } from '@/entities/demo';
import type { DemoShowcaseCopy } from '@/entities/demo';
import { selectCsrfToken, selectExpiresAt, selectPrincipal, sessionCleared } from '@/entities/user-session';
import { signOut } from '@/features/auth';
import { Alert, Button, Card, Skeleton, Spinner } from '@/shared/ui';

interface DemoContentGateProps {
  readonly children: ReactNode;
}

type CopyLoadState = 'loading' | 'loaded' | 'error';
const COPY_STATUS_POLL_LIMIT = 20;
const COPY_STATUS_POLL_INTERVAL_MS = 500;

export function DemoContentGate({ children }: DemoContentGateProps): React.JSX.Element {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const principal = useAppSelector(selectPrincipal);
  const csrfToken = useAppSelector(selectCsrfToken);
  const expiresAt = useAppSelector(selectExpiresAt);
  const [copy, setCopy] = useState<DemoShowcaseCopy | null>(null);
  const [loadState, setLoadState] = useState<CopyLoadState>('loading');
  const [refreshKey, setRefreshKey] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const redirectedToPrivateProject = useRef(false);
  const isInitialDemoEntry = location.pathname === '/dashboard' && isDemoAdmissionEntry(location.state);

  useEffect(() => {
    if (principal?.accountKind !== 'demo') return;
    let active = true;
    setLoadState('loading');
    async function loadCopyStatus(): Promise<void> {
      for (let attempt = 0; attempt < COPY_STATUS_POLL_LIMIT; attempt += 1) {
        if (!active) return;
        try {
          const result = await getDemoShowcaseCopy();
          if (!active) return;
          setCopy(result);
          setLoadState('loaded');
          if (result.state !== 'pending') return;
        } catch {
          if (active) setLoadState('error');
          return;
        }
        if (attempt + 1 < COPY_STATUS_POLL_LIMIT) {
          await new Promise<void>((resolve) => { setTimeout(resolve, COPY_STATUS_POLL_INTERVAL_MS); });
        }
      }
    }
    void loadCopyStatus();
    return () => { active = false; };
  }, [principal?.accountKind, principal?.id, refreshKey]);

  useEffect(() => {
    if (principal?.accountKind !== 'demo' || !isInitialDemoEntry || copy?.state !== 'ready' || !copy.projectId || redirectedToPrivateProject.current) return;
    redirectedToPrivateProject.current = true;
    navigate(`/projects/${encodeURIComponent(copy.projectId)}`, { replace: true });
  }, [copy, isInitialDemoEntry, navigate, principal?.accountKind]);

  if (principal?.accountKind !== 'demo') return <>{children}</>;
  const openingPrivateProject = isInitialDemoEntry && copy?.state === 'ready' && copy.projectId !== null && !redirectedToPrivateProject.current;
  if (openingPrivateProject) return <CopyOpeningProject />;
  if (loadState === 'loading') return <CopyPreparing />;
  if (loadState === 'error' || !copy) {
    return <CopyUnavailable onRefresh={refreshStatus} onSignOut={() => { void handleSignOut(); }} isSigningOut={isSigningOut} />;
  }
  if (copy.state !== 'ready') {
    return (
      <CopyUnavailable
        state={copy.state}
        retryAllowed={copy.retryAllowed}
        isRetrying={isRetrying}
        actionError={actionError}
        onRefresh={refreshStatus}
        onRetry={() => { void retryCopy(); }}
        onSignOut={() => { void handleSignOut(); }}
        isSigningOut={isSigningOut}
      />
    );
  }

  return <div className="min-h-screen"><PrivateDemoBanner expiresAt={expiresAt} planningOnly={!copy.capabilities?.fileAccess} />{children}</div>;

  function refreshStatus(): void {
    setActionError(false);
    setRefreshKey((key) => key + 1);
  }

  async function retryCopy(): Promise<void> {
    if (!csrfToken || isRetrying || !copy?.retryAllowed) return;
    setIsRetrying(true);
    setActionError(false);
    try {
      const result = await retryDemoShowcaseCopy(csrfToken);
      setCopy(result);
      setLoadState('loaded');
      if (result.state === 'pending') setRefreshKey((key) => key + 1);
    } catch {
      setActionError(true);
      setRefreshKey((key) => key + 1);
    } finally {
      setIsRetrying(false);
    }
  }

  async function handleSignOut(): Promise<void> {
    if (!csrfToken || isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut(csrfToken);
      dispatch(sessionCleared('signed-out'));
      navigate('/login?reason=signed-out', { replace: true });
    } catch {
      setActionError(true);
      setIsSigningOut(false);
    }
  }
}

function CopyOpeningProject(): React.JSX.Element {
  return (
    <main className="mx-auto grid min-h-screen max-w-2xl content-center gap-4 px-4 py-10" data-testid="demo-copy-opening" aria-busy="true">
      <p className="product-label">Private demo</p>
      <h1 className="text-3xl font-semibold">Opening your private workspace</h1>
      <p>Your private copy is ready. Opening it now.</p>
      <Spinner label="Opening your private workspace" />
    </main>
  );
}

function CopyPreparing(): React.JSX.Element {
  return (
    <main className="mx-auto grid min-h-screen max-w-2xl content-center gap-4 px-4 py-10" data-testid="demo-copy-preparing" aria-busy="true">
      <p className="product-label">Private demo</p>
      <h1 className="text-3xl font-semibold">Preparing your private demo…</h1>
      <p>Your editable workspace will open when its private copy is ready.</p>
      <Skeleton className="h-4 w-3/4" />
      <Spinner label="Preparing your private demo" />
      <Link className="text-[var(--color-link)] underline underline-offset-4" to="/showcase">View the read-only showcase</Link>
    </main>
  );
}

function isDemoAdmissionEntry(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'demoAdmissionEntry' in state && state.demoAdmissionEntry === true;
}

interface CopyUnavailableProps {
  readonly state?: 'pending' | 'failed';
  readonly retryAllowed?: boolean;
  readonly isRetrying?: boolean;
  readonly isSigningOut: boolean;
  readonly actionError?: boolean;
  readonly onRefresh: () => void;
  readonly onRetry?: () => void;
  readonly onSignOut: () => void;
}

function CopyUnavailable({ state, retryAllowed = false, isRetrying = false, isSigningOut, actionError = false, onRefresh, onRetry, onSignOut }: CopyUnavailableProps): React.JSX.Element {
  const preparing = state === 'pending';
  const retryableFailure = state === 'failed' && retryAllowed;
  const terminalFailure = state === 'failed' && !retryAllowed;
  return (
    <main className="mx-auto grid min-h-screen max-w-2xl content-center gap-4 px-4 py-10" data-testid="demo-copy-unavailable">
      <p className="product-label">Private demo</p>
      <h1 className="text-3xl font-semibold">{preparing ? 'Preparing your private demo…' : retryableFailure ? 'Your private demo isn’t ready yet.' : terminalFailure ? 'This demo session cannot be opened. No workspace was opened.' : 'Your private demo is unavailable.'}</h1>
      <p>{preparing ? 'No project content is available until the copy is ready.' : retryableFailure ? 'The private workspace stays hidden while setup is retried.' : terminalFailure ? 'Sign out before starting a new demo session.' : 'The private workspace is hidden until its copy is ready.'}</p>
      {actionError ? <Alert tone="error">The demo action could not be completed. Check the status and try again.</Alert> : null}
      <Card className="flex flex-wrap gap-3 p-4">
        {preparing ? <Button type="button" variant="secondary" onClick={onRefresh}>Refresh status</Button> : null}
        {!preparing && retryAllowed && onRetry ? <Button type="button" disabled={isRetrying} aria-busy={isRetrying} onClick={onRetry}>{isRetrying ? 'Retrying setup…' : 'Retry setup'}</Button> : null}
        {!preparing && !retryAllowed ? <Button type="button" variant="secondary" onClick={onRefresh}>Check status</Button> : null}
        <Button type="button" variant="ghost" disabled={isSigningOut} onClick={onSignOut}>{isSigningOut ? 'Signing out…' : 'Sign out'}</Button>
        <Link className="self-center text-[var(--color-link)] underline underline-offset-4" to="/showcase">View showcase</Link>
      </Card>
    </main>
  );
}

function PrivateDemoBanner({ expiresAt, planningOnly }: { readonly expiresAt: string | null; readonly planningOnly: boolean }): React.JSX.Element {
  return (
    <aside className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3" data-testid="private-demo-banner" aria-label="Private demo information">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-2">
        <strong>Private demo</strong>
        <span>{expiresAt ? `Expires ${formatExpiry(expiresAt)}` : 'Expiry unavailable'}</span>
        {planningOnly ? <span>Planning only</span> : null}
        <span>AI availability unavailable</span>
        <Link className="text-[var(--color-link)] underline underline-offset-4" to="/showcase">View showcase</Link>
      </div>
    </aside>
  );
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unavailable';
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
