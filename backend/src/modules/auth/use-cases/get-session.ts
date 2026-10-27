import type { AuthSessionSnapshot } from '@/modules/auth/domain/auth-types';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';
import type { IClock, IOpaqueTokenProvider } from '@/modules/auth/repositories/security-providers';
import type { ISessionRepository } from '@/modules/auth/repositories/session-repository';

export class GetSessionUseCase {
  public constructor(
    private readonly sessionRepository: ISessionRepository,
    private readonly tokenProvider: IOpaqueTokenProvider,
    private readonly clock: IClock
  ) {}

  public async execute(rawToken: string | undefined): Promise<AuthSessionSnapshot> {
    if (!rawToken || rawToken.length < 32) {
      throw new UnauthenticatedError();
    }
    const session = await this.sessionRepository.findByTokenHash(this.tokenProvider.digestToken(rawToken));
    const now = this.clock.now().getTime();
    if (
      !session
      || session.revokedAt
      || session.expiresAt.getTime() <= now
      || (session.accountExpiresAt !== null && session.accountExpiresAt.getTime() <= now)
    ) {
      throw new UnauthenticatedError();
    }
    return {
      sessionId: session.id,
      principal: {
        id: session.userId,
        displayName: session.displayName,
        accountKind: session.accountKind,
        role: session.role
      },
      csrfToken: this.tokenProvider.createCsrfToken(rawToken),
      expiresAt: session.expiresAt
    };
  }
}
