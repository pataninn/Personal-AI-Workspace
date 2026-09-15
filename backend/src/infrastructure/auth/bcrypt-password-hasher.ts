import bcrypt from 'bcryptjs';

import type { IPasswordHasher } from '@/modules/auth/repositories/security-providers';

const BCRYPT_COST = 12;

export class BcryptPasswordHasher implements IPasswordHasher {
  public async hash(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_COST);
  }

  public async verify(password: string, passwordHash: string): Promise<boolean> {
    return bcrypt.compare(password, passwordHash);
  }
}
