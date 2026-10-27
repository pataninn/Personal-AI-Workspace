export interface LocalPrincipal {
  readonly id: string;
  readonly displayName: string;
  readonly accountKind: 'regular' | 'demo';
  readonly role: 'user' | 'admin';
}

export interface SessionSnapshot {
  readonly principal: LocalPrincipal;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export type SessionStatus = 'unknown' | 'loading' | 'authenticated' | 'unauthenticated' | 'error';

export interface UserSessionState {
  readonly status: SessionStatus;
  readonly principal: LocalPrincipal | null;
  readonly csrfToken: string | null;
  readonly expiresAt: string | null;
  readonly errorCode: string | null;
}
