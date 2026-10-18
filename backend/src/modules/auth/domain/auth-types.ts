export type AccountKind = 'regular' | 'demo';
export type AccountRole = 'user' | 'admin';

export interface LocalPrincipal {
  readonly id: string;
  readonly displayName: string;
  readonly accountKind: AccountKind;
  readonly role: AccountRole;
}

export interface LocalUserRecord extends LocalPrincipal {
  readonly identifier: string | null;
  readonly passwordHash: string | null;
  readonly isActive: boolean;
  readonly expiresAt: Date | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly accountKind: AccountKind;
  readonly role: AccountRole;
  readonly accountExpiresAt: Date | null;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface AuthSessionSnapshot {
  readonly sessionId: string;
  readonly principal: LocalPrincipal;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}
