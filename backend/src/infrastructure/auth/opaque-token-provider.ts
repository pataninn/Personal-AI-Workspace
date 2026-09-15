import { createHmac, randomBytes } from 'node:crypto';

import type { IOpaqueTokenProvider } from '@/modules/auth/repositories/security-providers';

export class OpaqueTokenProvider implements IOpaqueTokenProvider {
  public constructor(private readonly secret: string) {}

  public createToken(): string {
    return randomBytes(32).toString('base64url');
  }

  public digestToken(token: string): string {
    return createHmac('sha256', this.secret).update(`session:${token}`).digest('hex');
  }

  public createCsrfToken(token: string): string {
    return createHmac('sha256', this.secret).update(`csrf:${token}`).digest('base64url');
  }
}
