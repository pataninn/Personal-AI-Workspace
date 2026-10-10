import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { sessionAuthenticated } from '@/entities/user-session';
import { signIn, AUTH_COPY } from '@/features/auth';
import { useAppDispatch } from '@/app/store/hooks';
import { ApiClientError } from '@/shared/api';
import { getSafeReturnTo } from '@/shared/lib/navigation';
import { Alert, Button, Card, Icon, Input, Label, Spinner } from '@/shared/ui';
import { SignInArtwork } from './SignInArtwork';

const REQUIRED_MESSAGE = 'Enter your local password.';
const LENGTH_MESSAGE = 'Enter a password between 1 and 1024 characters.';
const MAX_PASSWORD_LENGTH = 1024;

export function SignInForm(): React.JSX.Element {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const params = new URLSearchParams(location.search);
  const returnTo = getSafeReturnTo(params.get('returnTo'));
  const reason = params.get('reason');

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function validate(): boolean {
    const trimmedLength = password.trim().length;
    if (trimmedLength === 0) {
      setFieldError(REQUIRED_MESSAGE);
      inputRef.current?.focus();
      return false;
    }
    if (trimmedLength <= MAX_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH) {
      setFieldError(null);
      return true;
    }
    setFieldError(LENGTH_MESSAGE);
    inputRef.current?.focus();
    return false;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setServerError(null);
    if (!validate()) {
      return;
    }
    setIsSubmitting(true);
    try {
      const snapshot = await signIn(password);
      dispatch(sessionAuthenticated(snapshot));
      setStatusMessage('Signed in. Loading your workspace.');
      navigate(returnTo ?? '/dashboard', { replace: true });
    } catch (error: unknown) {
      setServerError(toLoginError(error));
      inputRef.current?.focus();
    } finally {
      setIsSubmitting(false);
    }
  }

  const notice = reason === 'session-expired'
    ? AUTH_COPY.sessionExpired
    : reason === 'signed-out' ? AUTH_COPY.signedOut : null;

  return (
    <main className="login-view" data-testid="login-page">
      <SignInArtwork />
      <Card className="login-card">
        <p className="product-label">Personal AI Workspace</p>
        <h1>Sign in</h1>
        <p className="supporting-copy">{import.meta.env.MODE === 'preview' ? 'Use any non-empty made-up password. Do not enter a real password.' : 'Use the local password configured for this workspace.'}</p>
        {notice ? <Alert tone={reason === 'signed-out' ? 'success' : 'info'} live="polite">{notice}</Alert> : null}
        <form data-testid="login-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="field-group">
            <Label htmlFor="local-password">Local password</Label>
            <Input
              ref={inputRef}
              id="local-password"
              data-testid="login-password-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-required="true"
              aria-invalid={fieldError ? 'true' : 'false'}
              aria-describedby={fieldError ? 'login-password-error' : undefined}
              disabled={isSubmitting}
              autoComplete="current-password"
            />
            {fieldError ? <p id="login-password-error" className="field-error" role="alert">{fieldError}</p> : null}
          </div>
          {serverError ? <Alert tone="error" data-testid="login-error-message">{serverError}</Alert> : null}
          <Button
            data-testid="login-submit-button"
            type="submit"
            disabled={isSubmitting}
            aria-busy={isSubmitting}
          >
            {isSubmitting ? <><Spinner label="Signing in" /> Signing in…</> : <><span>Sign in</span><Icon name="arrow" size={18} /></>}
          </Button>
        </form>
        <p className="privacy-note">{import.meta.env.MODE === 'preview' ? 'This browser preview uses temporary mock data on loopback HTTP.' : 'This is a local workspace. Your password is sent only to this app over its configured HTTPS origin.'}</p>
        <p className="sr-only" data-testid="login-status-message" aria-live="polite">{statusMessage}</p>
      </Card>
    </main>
  );
}

function toLoginError(error: unknown): string {
  if (!(error instanceof ApiClientError)) {
    return AUTH_COPY.unavailable;
  }
  if (error.code === 'INVALID_CREDENTIALS') {
    return AUTH_COPY.invalidCredentials;
  }
  if (error.code === 'AUTH_RATE_LIMITED') {
    return AUTH_COPY.rateLimited;
  }
  if (error.code === 'SETUP_REQUIRED') {
    return AUTH_COPY.setupRequired;
  }
  if (error.code === 'VALIDATION_ERROR') {
    return AUTH_COPY.validation;
  }
  return error.statusCode >= 500 ? AUTH_COPY.unavailable : AUTH_COPY.invalidCredentials;
}
