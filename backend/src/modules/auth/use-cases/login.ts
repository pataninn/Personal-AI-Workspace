import type { LocalPrincipal } from '@/modules/auth/domain/auth-types';
import { InvalidCredentialsError, SetupRequiredError } from '@/modules/auth/domain/auth-errors';
import type { IUserRepository } from '@/modules/auth/repositories/user-repository';
import type { ISessionRepository } from '@/modules/auth/repositories/session-repository';
import type { IClock, IOpaqueTokenProvider, IPasswordHasher } from '@/modules/auth/repositories/security-providers';

export interface LoginInput {
  readonly password: string;
}

export interface LoginResult {
  readonly sessionId: string;
  readonly principal: LocalPrincipal;
  readonly rawToken: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

export interface LoginUseCaseOptions {
  readonly sessionLifetimeMs: number;
}

export class LoginUseCase {
  public constructor(
    private readonly userRepository: IUserRepository,
    private readonly sessionRepository: ISessionRepository,
    private readonly passwordHasher: IPasswordHasher,
    private readonly tokenProvider: IOpaqueTokenProvider,
    private readonly clock: IClock,
    private readonly options: LoginUseCaseOptions
  ) {}

  public async execute(input: LoginInput): Promise<LoginResult> {
    const user = await this.userRepository.findActiveLocalUser();
    if (!user) {
      throw new SetupRequiredError();
    }
    const passwordAccepted = await this.passwordHasher.verify(input.password, user.passwordHash);
    if (!passwordAccepted) {
      throw new InvalidCredentialsError();
    }

    const rawToken = this.tokenProvider.createToken();
    const expiresAt = new Date(this.clock.now().getTime() + this.options.sessionLifetimeMs);
    const session = await this.sessionRepository.create({
      userId: user.id,
      tokenHash: this.tokenProvider.digestToken(rawToken),
      expiresAt
    });
    return {
      sessionId: session.id,
      principal: { id: user.id, displayName: user.displayName },
      rawToken,
      csrfToken: this.tokenProvider.createCsrfToken(rawToken),
      expiresAt: session.expiresAt
    };
  }
}
