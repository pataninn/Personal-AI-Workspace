import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { sessionAuthenticated } from '@/entities/user-session';
import { signIn, AUTH_COPY } from '@/features/auth';
import { useAppDispatch } from '@/app/store/hooks';
import { ApiClientError } from '@/shared/api';
import { getSafeReturnTo } from '@/shared/lib/navigation';
import { Alert, Button, Card, Icon, Input, Label, Spinner } from '@/shared/ui';
import { SignInArtwork } from './SignInArtwork';

const IDENTIFIER_REQUIRED_MESSAGE = 'Enter your account identifier.';
const IDENTIFIER_INVALID_MESSAGE = 'Enter a valid account identifier.';
const PASSWORD_REQUIRED_MESSAGE = 'Enter your password.';
const PASSWORD_LENGTH_MESSAGE = 'Enter a password between 1 and 1024 characters.';
const MAX_PASSWORD_LENGTH = 1024;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/u;

export function SignInForm(): React.JSX.Element {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const identifierInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [identifierError, setIdentifierError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const params = new URLSearchParams(location.search);
  const returnTo = getSafeReturnTo(params.get('returnTo'));
  const reason = params.get('reason');

  useEffect(() => {
    identifierInputRef.current?.focus();
  }, []);

  function validate(): boolean {
    setIdentifierError(null);
    setPasswordError(null);
    const trimmedIdentifier = identifier.trim();
    const normalizedIdentifier = /[^\x00-\x7f]/u.test(trimmedIdentifier)
      ? trimmedIdentifier
      : trimmedIdentifier.toLowerCase();
    if (!normalizedIdentifier) {
      setIdentifierError(IDENTIFIER_REQUIRED_MESSAGE);
      identifierInputRef.current?.focus();
      return false;
    }
    if (!IDENTIFIER_PATTERN.test(normalizedIdentifier)) {
      setIdentifierError(IDENTIFIER_INVALID_MESSAGE);
      identifierInputRef.current?.focus();
      return false;
    }
    const trimmedLength = password.trim().length;
    if (trimmedLength === 0) {
      setPasswordError(PASSWORD_REQUIRED_MESSAGE);
      passwordInputRef.current?.focus();
      return false;
    }
    if (trimmedLength <= MAX_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH) {
      return true;
    }
    setPasswordError(PASSWORD_LENGTH_MESSAGE);
    passwordInputRef.current?.focus();
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
      const snapshot = await signIn(identifier, password);
      dispatch(sessionAuthenticated(snapshot));
      setStatusMessage('Signed in. Loading your workspace.');
      navigate(returnTo ?? '/dashboard', { replace: true });
    } catch (error: unknown) {
      setServerError(toLoginError(error));
      passwordInputRef.current?.focus();
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
        <p className="supporting-copy">{import.meta.env.MODE === 'preview' ? 'Use any account identifier and non-empty made-up password. Do not enter real credentials.' : 'Use your account identifier and password.'}</p>
        {notice ? <Alert tone={reason === 'signed-out' ? 'success' : 'info'} live="polite">{notice}</Alert> : null}
        <form data-testid="login-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="field-group">
            <Label htmlFor="account-identifier">Account identifier</Label>
            <Input
              ref={identifierInputRef}
              id="account-identifier"
              data-testid="login-identifier-input"
              type="text"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              aria-required="true"
              aria-invalid={identifierError ? 'true' : 'false'}
              aria-describedby={identifierError ? 'login-identifier-error' : undefined}
              disabled={isSubmitting}
              autoComplete="username"
              maxLength={64}
              autoCapitalize="none"
              spellCheck={false}
            />
            {identifierError ? <p id="login-identifier-error" className="field-error" role="alert">{identifierError}</p> : null}
          </div>
          <div className="field-group">
            <Label htmlFor="local-password">Password</Label>
            <Input
              ref={passwordInputRef}
              id="local-password"
              data-testid="login-password-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-required="true"
              aria-invalid={passwordError ? 'true' : 'false'}
              aria-describedby={passwordError ? 'login-password-error' : undefined}
              disabled={isSubmitting}
              autoComplete="current-password"
            />
            {passwordError ? <p id="login-password-error" className="field-error" role="alert">{passwordError}</p> : null}
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
