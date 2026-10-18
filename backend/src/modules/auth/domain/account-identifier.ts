export const OWNER_ACCOUNT_IDENTIFIER = 'owner';
export const ACCOUNT_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/u;

export function normalizeAccountIdentifier(value: string): string {
  const trimmed = value.trim();
  return /[^\x00-\x7f]/u.test(trimmed) ? trimmed : trimmed.toLowerCase();
}

export function isValidAccountIdentifier(value: string): boolean {
  return ACCOUNT_IDENTIFIER_PATTERN.test(value);
}
