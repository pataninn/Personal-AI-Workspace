import type { IPasswordHasher } from '@/modules/auth/repositories/security-providers';
import type { GetStorageUsage } from '@/modules/storage-quotas/use-cases/get-storage-usage';
import type { AccountLimitsInput, DemoSettingsInput, IAdminPortalRepository } from '@/modules/admin-portal/repositories/admin-portal-repository';
import { AdminPortalUseCases } from '@/modules/admin-portal/use-cases/admin-portal-use-cases';

function repository(): jest.Mocked<IAdminPortalRepository> {
  return {
    listAccounts: jest.fn(async (_search: string): Promise<unknown> => ({ accounts: [] })),
    readCreditUsage: jest.fn(async (_ownerId: string): Promise<unknown> => ({})),
    getDemoSettings: jest.fn(async () => ({})),
    updateDemoSettings: jest.fn(async (_actorId: string, _input: DemoSettingsInput): Promise<unknown> => ({})),
    listAudit: jest.fn(async (_limit: number): Promise<unknown> => ({ events: [] })),
    updateAccountLimits: jest.fn(async (_actorId: string, _accountId: string, _input: AccountLimitsInput): Promise<unknown> => ({})),
    setAccountEnabled: jest.fn(async (_actorId: string, _accountId: string, _enabled: boolean): Promise<unknown> => ({})),
    resetPassword: jest.fn(async (_actorId: string, _accountId: string, _passwordHash: string): Promise<void> => undefined),
    revokeSessions: jest.fn(async (_actorId: string, _accountId: string): Promise<void> => undefined)
  };
}

function useCases(repo: jest.Mocked<IAdminPortalRepository>, hash = jest.fn(async (value: string) => `hash:${value}`)): {
  readonly instance: AdminPortalUseCases;
  readonly hash: jest.MockedFunction<IPasswordHasher['hash']>;
} {
  const passwordHasher: IPasswordHasher = { hash, verify: jest.fn(async () => false) };
  const storage = { execute: jest.fn(async () => ({})) } as unknown as GetStorageUsage;
  return { instance: new AdminPortalUseCases(repo, passwordHasher, storage), hash };
}

describe('AdminPortalUseCases', () => {
  it('passes zero and null account limits distinctly through the CAS boundary', async () => {
    const repo = repository();
    const { instance } = useCases(repo);

    await instance.updateAccountLimits('admin-id', 'account-id', {
      expectedRevision: 4, dailyCreditLimitUnits: '0', lifetimeCreditLimitUnits: null, storageLimitBytes: '0'
    });

    expect(repo.updateAccountLimits).toHaveBeenCalledWith('admin-id', 'account-id', {
      expectedRevision: 4, dailyCreditLimitUnits: '0', lifetimeCreditLimitUnits: null, storageLimitBytes: '0'
    });
  });

  it('accepts a zero allowance as finite but refuses an entirely unlimited new-demo default', async () => {
    const repo = repository();
    const { instance } = useCases(repo);
    const settings = {
      expectedRevision: 2,
      defaultDailyLimitUnits: null,
      defaultLifetimeLimitUnits: '0',
      sessionTtlHours: null,
      globalAdmissionMax: null,
      globalAdmissionWindowSeconds: null,
      networkAdmissionMax: null,
      networkAdmissionWindowSeconds: null,
      runStartMax: null,
      runStartWindowSeconds: null,
      maxConcurrentCalls: 3,
      globalDailyLimitUnits: null,
      campaignId: null,
      campaignLimitUnits: null,
      inferencePaused: false
    } as const;

    await instance.updateDemoSettings('admin-id', settings);
    expect(repo.updateDemoSettings).toHaveBeenCalledWith('admin-id', settings);
    expect(() => instance.updateDemoSettings('admin-id', { ...settings, defaultLifetimeLimitUnits: null }))
      .toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }));
  });

  it('rejects partial or unsafe admission windows before reaching the repository', async () => {
    const repo = repository();
    const { instance } = useCases(repo);
    const settings = {
      expectedRevision: 2, defaultDailyLimitUnits: '100', defaultLifetimeLimitUnits: null, sessionTtlHours: 24,
      globalAdmissionMax: 10, globalAdmissionWindowSeconds: 900, networkAdmissionMax: null,
      networkAdmissionWindowSeconds: null, runStartMax: null, runStartWindowSeconds: null,
      maxConcurrentCalls: 1, globalDailyLimitUnits: null, campaignId: null, campaignLimitUnits: null, inferencePaused: false
    } as const;

    expect(() => instance.updateDemoSettings('admin-id', settings)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => instance.updateDemoSettings('admin-id', { ...settings, globalAdmissionWindowSeconds: 600,
      networkAdmissionMax: 3, networkAdmissionWindowSeconds: 1200, runStartMax: 4, runStartWindowSeconds: 300 }))
      .toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(repo.updateDemoSettings).not.toHaveBeenCalled();
  });

  it('hashes and revokes through the repository without returning or auditing a reset password', async () => {
    const repo = repository();
    const { instance, hash } = useCases(repo);
    const rawPassword = 'next-secret-value';

    await expect(instance.resetPassword('admin-id', 'account-id', rawPassword)).resolves.toBeUndefined();

    expect(hash).toHaveBeenCalledWith(rawPassword);
    expect(repo.resetPassword).toHaveBeenCalledWith('admin-id', 'account-id', `hash:${rawPassword}`);
  });
});
