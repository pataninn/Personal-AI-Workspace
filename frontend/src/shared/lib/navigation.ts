export function getSafeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('://')) {
    return null;
  }
  return value;
}

export function loginPath(reason?: string, returnTo?: string | null): string {
  const params = new URLSearchParams();
  if (reason) {
    params.set('reason', reason);
  }
  const safeReturnTo = getSafeReturnTo(returnTo ?? null);
  if (safeReturnTo) {
    params.set('returnTo', safeReturnTo);
  }
  const query = params.toString();
  return query ? `/login?${query}` : '/login';
}
