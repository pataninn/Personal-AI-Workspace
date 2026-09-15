export interface LocalPrincipal {
  readonly id: string;
  readonly displayName: string;
}

export interface LocalUserRecord extends LocalPrincipal {
  readonly passwordHash: string;
  readonly isActive: boolean;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface AuthSessionSnapshot {
  readonly sessionId: string;
  readonly principal: LocalPrincipal;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}
