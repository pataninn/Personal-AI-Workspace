import type { IClock } from '@/modules/auth/repositories/security-providers';

export class SystemClock implements IClock {
  public now(): Date {
    return new Date();
  }
}
