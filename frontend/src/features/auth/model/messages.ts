export const AUTH_COPY = {
  invalidCredentials: 'That account identifier or password was not accepted. Check both and try again.',
  rateLimited: 'Too many attempts. Wait a moment, then try again.',
  validation: 'Check the account identifier and password format, then try again.',
  unavailable: 'We could not reach the local app. Check that it is running, then try again.',
  setupRequired: 'Local setup is required before you can sign in. Ask the local operator to configure the owner account and password.',
  sessionExpired: 'Your local session expired. Sign in again to continue.',
  signedOut: 'You have been signed out.',
  logoutFailed: 'We could not confirm sign out. Try again.'
} as const;
