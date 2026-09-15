export const AUTH_COPY = {
  invalidCredentials: 'That password was not accepted. Check it and try again.',
  rateLimited: 'Too many attempts. Wait a moment, then try again.',
  validation: 'Enter a valid local password and try again.',
  unavailable: 'We could not reach the local app. Check that it is running, then try again.',
  setupRequired: 'Local setup is required before you can sign in. Ask the local operator to configure a password.',
  sessionExpired: 'Your local session expired. Sign in again to continue.',
  signedOut: 'You have been signed out.',
  logoutFailed: 'We could not confirm sign out. Try again.'
} as const;
