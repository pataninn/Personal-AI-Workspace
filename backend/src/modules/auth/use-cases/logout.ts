import type { ISessionRepository } from '@/modules/auth/repositories/session-repository';

export class LogoutUseCase {
  public constructor(private readonly sessionRepository: ISessionRepository) {}

  public async execute(sessionId: string): Promise<void> {
    await this.sessionRepository.revoke(sessionId);
  }
}
