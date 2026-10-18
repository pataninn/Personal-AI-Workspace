import type { IUserRepository } from '@/modules/auth/repositories/user-repository';
import type { IPasswordHasher } from '@/modules/auth/repositories/security-providers';
import { OWNER_ACCOUNT_IDENTIFIER } from '@/modules/auth/domain/account-identifier';

export interface BootstrapLocalUserInput {
  readonly password: string;
  readonly displayName: string;
}

export class BootstrapLocalUserUseCase {
  public constructor(
    private readonly userRepository: IUserRepository,
    private readonly passwordHasher: IPasswordHasher
  ) {}

  public async execute(input: BootstrapLocalUserInput): Promise<boolean> {
    if (await this.userRepository.findByIdentifier(OWNER_ACCOUNT_IDENTIFIER)) {
      return false;
    }
    return this.userRepository.bootstrapInitialAdmin({
      displayName: input.displayName,
      passwordHash: await this.passwordHasher.hash(input.password)
    });
  }
}
