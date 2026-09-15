import type { ILoginRateLimiter } from '@/modules/auth/repositories/security-providers';

interface RateLimitEntry {
  readonly startedAt: number;
  readonly attempts: number;
}

export class InMemoryLoginRateLimiter implements ILoginRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  public constructor(
    private readonly maxAttempts = 10,
    private readonly windowMs = 15 * 60 * 1_000
  ) {}

  public consume(key: string): boolean {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (!existing || now - existing.startedAt >= this.windowMs) {
      this.entries.set(key, { startedAt: now, attempts: 1 });
      return true;
    }
    if (existing.attempts >= this.maxAttempts) {
      return false;
    }
    this.entries.set(key, { ...existing, attempts: existing.attempts + 1 });
    return true;
  }
}
