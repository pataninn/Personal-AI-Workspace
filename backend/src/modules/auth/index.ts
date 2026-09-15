export { clearSessionCookie, createAuthRouter, type AuthRouterDependencies } from '@/modules/auth/controllers/auth-router';
export { LoginUseCase, type LoginResult } from '@/modules/auth/use-cases/login';
export { GetSessionUseCase } from '@/modules/auth/use-cases/get-session';
export { LogoutUseCase } from '@/modules/auth/use-cases/logout';
export { BootstrapLocalUserUseCase } from '@/modules/auth/use-cases/bootstrap-local-user';
export type { LocalPrincipal, AuthSessionSnapshot } from '@/modules/auth/domain/auth-types';
export type { IUserRepository } from '@/modules/auth/repositories/user-repository';
export type { ISessionRepository } from '@/modules/auth/repositories/session-repository';
export type { IClock, ILoginRateLimiter, IOpaqueTokenProvider, IPasswordHasher } from '@/modules/auth/repositories/security-providers';
