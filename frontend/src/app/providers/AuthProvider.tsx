import { useEffect, useRef, useState } from 'react';

import { getCurrentSession } from '@/features/auth';
import { sessionAuthenticated, sessionBootstrapFailed, sessionCheckStarted, sessionCleared, sessionUnauthenticated, selectSessionStatus } from '@/entities/user-session';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { ApiClientError, registerSessionExpiryHandler } from '@/shared/api';
import { Button, ErrorState, Skeleton, Spinner } from '@/shared/ui';

interface AuthProviderProps {
  readonly children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps): React.JSX.Element {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectSessionStatus);
  const [retryCount, setRetryCount] = useState(0);
  const hasBootstrapped = useRef(false);

  useEffect(() => registerSessionExpiryHandler(() => {
    dispatch(sessionCleared('SESSION_UNAUTHENTICATED'));
  }), [dispatch]);

  useEffect(() => {
    if (hasBootstrapped.current && retryCount === 0) {
      return;
    }
    hasBootstrapped.current = true;
    let cancelled = false;
    dispatch(sessionCheckStarted());
    void getCurrentSession()
      .then((snapshot) => {
        if (!cancelled) {
          dispatch(sessionAuthenticated(snapshot));
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiClientError && error.statusCode === 401) {
          dispatch(sessionUnauthenticated(error.code));
          return;
        }
        dispatch(sessionBootstrapFailed(error instanceof ApiClientError ? error.code : 'NETWORK_ERROR'));
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch, retryCount]);

  if (status === 'unknown' || status === 'loading') {
    return <BootstrapLoading />;
  }
  if (status === 'error') {
    return <BootstrapError onRetry={() => setRetryCount((value) => value + 1)} />;
  }
  return <>{children}</>;
}

function BootstrapLoading(): React.JSX.Element {
  return (
    <main className="bootstrap-view" data-testid="session-bootstrap-loading" aria-busy="true">
      <p className="product-label brand-wordmark">Threadnest<span className="brand-dot" aria-hidden="true">.</span></p>
      <Skeleton className="bootstrap-skeleton" />
      <div className="bootstrap-status">
        <Spinner label="Checking your local session" />
        <p>Checking your local session…</p>
      </div>
    </main>
  );
}

function BootstrapError({ onRetry }: { readonly onRetry: () => void }): React.JSX.Element {
  return (
    <main className="bootstrap-view" data-testid="session-bootstrap-error">
      <ErrorState
        title="The local app is unavailable"
        detail="Start or reconnect the local app, then try again."
        action={<Button data-testid="session-bootstrap-retry-button" onClick={onRetry}>Try again</Button>}
      />
    </main>
  );
}
