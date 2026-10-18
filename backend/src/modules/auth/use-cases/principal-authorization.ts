import type { IUserRepository } from '@/modules/auth/repositories/user-repository';
import type { IClock } from '@/modules/auth/repositories/security-providers';
import { UnauthenticatedError } from '@/modules/auth/domain/auth-errors';

/**
 * Rechecks persisted account state for work that can outlive the HTTP request.
 * Session snapshots are not sufficient authority after a disable or expiry.
 */
export interface IPrincipalAuthorization {
  isActive(principalId: string): Promise<boolean>;
  assertActive(principalId: string): Promise<void>;
  withActivePrincipal<T>(principalId: string, action: (assertStillActive: () => Promise<void>) => Promise<T>): Promise<T>;
}

export class PrincipalAuthorization implements IPrincipalAuthorization {
  public constructor(private readonly users: IUserRepository, private readonly clock: IClock) {}

  public async isActive(principalId: string): Promise<boolean> {
    if (this.users.isActive) {
      return this.users.isActive(principalId);
    }
    const user = await this.users.findById(principalId);
    if (!user || !user.isActive) {
      return false;
    }
    return user.expiresAt === null || user.expiresAt.getTime() > this.clock.now().getTime();
  }

  public async assertActive(principalId: string): Promise<void> {
    if (!await this.isActive(principalId)) {
      throw new UnauthenticatedError();
    }
  }

  public async withActivePrincipal<T>(principalId: string, action: (assertStillActive: () => Promise<void>) => Promise<T>): Promise<T> {
    if (this.users.withActivePrincipal) {
      return this.users.withActivePrincipal(principalId, action);
    }
    await this.assertActive(principalId);
    return action(() => this.assertActive(principalId));
  }
}
