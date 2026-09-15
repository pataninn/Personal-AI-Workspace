import type { IUserRepository } from '@/modules/auth/repositories/user-repository';
import type { IPasswordHasher } from '@/modules/auth/repositories/security-providers';

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
    const existingUser = await this.userRepository.findActiveLocalUser();
    if (existingUser) {
      return false;
    }
    await this.userRepository.createLocalUser({
      displayName: input.displayName,
      passwordHash: await this.passwordHasher.hash(input.password)
    });
    return true;
  }
}
