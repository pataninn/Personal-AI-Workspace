export interface IPasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, passwordHash: string): Promise<boolean>;
}

export interface IOpaqueTokenProvider {
  createToken(): string;
  digestToken(token: string): string;
  createCsrfToken(token: string): string;
}

export interface IClock {
  now(): Date;
}

export interface ILoginRateLimiter {
  consume(key: string): boolean;
}
