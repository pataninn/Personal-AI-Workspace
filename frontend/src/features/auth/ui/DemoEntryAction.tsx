import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAppDispatch } from '@/app/store/hooks';
import { createDemoAdmissionKey, createDemoSession, getDemoAvailability } from '@/entities/demo';
import { sessionAuthenticated } from '@/entities/user-session';
import type { SessionSnapshot } from '@/entities/user-session';
import { getCurrentSession } from '@/features/auth/api/auth-api';
import { ApiClientError } from '@/shared/api';
import { Alert, Button, Spinner } from '@/shared/ui';

type AvailabilityState = 'loading' | 'available' | 'unavailable' | 'error';

export function DemoEntryAction(): React.JSX.Element {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const idempotencyKey = useRef<string | null>(null);
  const [availability, setAvailability] = useState<AvailabilityState>('loading');
  const [availabilityAttempt, setAvailabilityAttempt] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setAvailability('loading');
    void getDemoAvailability()
      .then((result) => {
        if (active) setAvailability(result.available ? 'available' : 'unavailable');
      })
      .catch(() => {
        if (active) setAvailability('error');
      });
    return () => { active = false; };
  }, [availabilityAttempt]);

  async function startDemo(): Promise<void> {
    if (isSubmitting || availability !== 'available') return;
    setIsSubmitting(true);
    setMessage(null);
    try {
      idempotencyKey.current ??= createDemoAdmissionKey();
      const result = await createDemoSession(idempotencyKey.current);
      if (!('principal' in result)) {
        idempotencyKey.current = null;
        setMessage('This demo admission could not be resumed in this browser. Try again to start or resume a session.');
        return;
      }
      const snapshot: SessionSnapshot = {
        principal: result.principal,
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt
      };
      dispatch(sessionAuthenticated(snapshot));
      idempotencyKey.current = null;
      navigate('/dashboard', { replace: true, state: { demoAdmissionEntry: true } });
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.code === 'DEMO_REGULAR_SESSION_ACTIVE') {
        await resumeExistingSession();
        return;
      }
      setMessage('The demo could not be started. Try again.');
      if (error instanceof ApiClientError && error.code === 'DEMO_SHOWCASE_UNAVAILABLE') {
        setAvailability('unavailable');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function resumeExistingSession(): Promise<void> {
    try {
      const snapshot = await getCurrentSession();
      dispatch(sessionAuthenticated(snapshot));
      navigate('/dashboard', { replace: true });
    } catch {
      setMessage('A signed-in workspace is already active in this browser. Return to sign in and try your workspace again.');
    }
  }

  return (
    <section className="mt-6 border-t border-[var(--color-border)] pt-5" aria-labelledby="demo-entry-title">
      <h2 id="demo-entry-title" className="text-lg font-semibold">Explore a private demo</h2>
      <p className="supporting-copy">Start a separate editable workspace. This browser session is the only way to access it.</p>
      {availability === 'unavailable' ? <Alert tone="info" data-testid="demo-unavailable-message">Demo is unavailable right now.</Alert> : null}
      {availability === 'error' ? <Alert tone="error" role="status" data-testid="demo-availability-error">Demo availability could not be checked.</Alert> : null}
      {message ? <Alert tone="error" data-testid="demo-entry-error">{message}</Alert> : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          data-testid="try-demo-button"
          disabled={availability !== 'available' || isSubmitting}
          aria-busy={isSubmitting}
          onClick={() => { void startDemo(); }}
        >
          {isSubmitting ? <><Spinner label="Preparing your private demo" /> Preparing your private demo…</> : 'Try demo'}
        </Button>
        {availability === 'error' ? (
          <Button type="button" variant="ghost" data-testid="demo-availability-retry" onClick={() => setAvailabilityAttempt((attempt) => attempt + 1)}>
            Try again
          </Button>
        ) : null}
        <Link className="text-[var(--color-link)] underline underline-offset-4" to="/showcase">View read-only showcase</Link>
      </div>
    </section>
  );
}
