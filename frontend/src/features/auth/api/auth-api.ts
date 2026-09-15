import { getJson, postJson, postNoContent } from '@/shared/api';
import type { SessionSnapshot } from '@/entities/user-session';

const LOGIN_PATH = '/api/v1/auth/login';
const SESSION_PATH = '/api/v1/auth/session';
const LOGOUT_PATH = '/api/v1/auth/logout';

export function getCurrentSession(): Promise<SessionSnapshot> {
  return getJson<SessionSnapshot>(SESSION_PATH);
}

export function signIn(password: string): Promise<SessionSnapshot> {
  return postJson<SessionSnapshot>(LOGIN_PATH, { password });
}

export function signOut(csrfToken: string): Promise<void> {
  return postNoContent(LOGOUT_PATH, { 'X-CSRF-Token': csrfToken });
}
