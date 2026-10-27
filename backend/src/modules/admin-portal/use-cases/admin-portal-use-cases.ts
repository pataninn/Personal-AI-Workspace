import { AppError } from '@/shared/errors/app-error';
import { isValidAccountIdentifier, normalizeAccountIdentifier } from '@/modules/auth/domain/account-identifier';
import type { IPasswordHasher } from '@/modules/auth/repositories/security-providers';
import type { GetStorageUsage } from '@/modules/storage-quotas/use-cases/get-storage-usage';
import type { AccountLimitsInput, DemoSettingsInput, IAdminPortalRepository } from '@/modules/admin-portal/repositories/admin-portal-repository';

const MAX_BIGINT = 9_223_372_036_854_775_807n;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/u;

function invalid(field = 'request'): AppError {
  return new AppError('VALIDATION_ERROR', 400, 'The admin request is invalid.', [{ field, message: 'Enter a valid value.' }]);
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid('expectedRevision');
}

function assertUnits(value: string | null, field: string): void {
  if (value === null) return;
  if (!DECIMAL_INTEGER.test(value) || BigInt(value) > MAX_BIGINT) throw invalid(field);
}

function boundedInteger(value: number | null, minimum: number, maximum: number, field: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) throw invalid(field);
}

export class AdminPortalUseCases {
  public constructor(
    private readonly repository: IAdminPortalRepository,
    private readonly passwordHasher: IPasswordHasher,
    private readonly getStorageUsage: GetStorageUsage
  ) {}

  public listAccounts(search = ''): Promise<unknown> {
    if (search.length > 120) throw invalid('search');
    return this.repository.listAccounts(search.trim());
  }

  public async getUsage(ownerId: string): Promise<unknown> {
    try {
      const credits = await this.repository.readCreditUsage(ownerId) as Record<string, unknown>;
      const storage = await this.getStorageUsage.execute(ownerId);
      return { ...credits, storage };
    } catch {
      throw new AppError('USAGE_UNAVAILABLE', 503, 'Account usage is temporarily unavailable.');
    }
  }

  public getDemoSettings(): Promise<unknown> { return this.repository.getDemoSettings(); }

  public updateDemoSettings(actorId: string, input: DemoSettingsInput): Promise<unknown> {
    assertRevision(input.expectedRevision);
    assertUnits(input.defaultDailyLimitUnits, 'defaultDailyLimitUnits');
    assertUnits(input.defaultLifetimeLimitUnits, 'defaultLifetimeLimitUnits');
    assertUnits(input.globalDailyLimitUnits, 'globalDailyLimitUnits');
    assertUnits(input.campaignLimitUnits, 'campaignLimitUnits');
    if (input.defaultDailyLimitUnits === null && input.defaultLifetimeLimitUnits === null) {
      throw invalid('defaultDailyLimitUnits');
    }
    boundedInteger(input.sessionTtlHours, 1, 24, 'sessionTtlHours');
    boundedInteger(input.globalAdmissionMax, 1, 1_000_000, 'globalAdmissionMax');
    boundedInteger(input.globalAdmissionWindowSeconds, 60, 604_800, 'globalAdmissionWindowSeconds');
    boundedInteger(input.networkAdmissionMax, 1, 1_000_000, 'networkAdmissionMax');
    boundedInteger(input.networkAdmissionWindowSeconds, 60, 604_800, 'networkAdmissionWindowSeconds');
    boundedInteger(input.runStartMax, 1, 1_000_000, 'runStartMax');
    boundedInteger(input.runStartWindowSeconds, 60, 604_800, 'runStartWindowSeconds');
    boundedInteger(input.maxConcurrentCalls, 1, 32, 'maxConcurrentCalls');
    const admissionValues = [input.globalAdmissionMax, input.globalAdmissionWindowSeconds, input.networkAdmissionMax,
      input.networkAdmissionWindowSeconds, input.runStartMax, input.runStartWindowSeconds];
    if (admissionValues.some((value) => value === null) && admissionValues.some((value) => value !== null)) {
      throw invalid('globalAdmissionMax');
    }
    if (input.networkAdmissionWindowSeconds !== null && input.globalAdmissionWindowSeconds !== null
      && input.networkAdmissionWindowSeconds > input.globalAdmissionWindowSeconds) throw invalid('networkAdmissionWindowSeconds');
    if ((input.campaignId === null) !== (input.campaignLimitUnits === null)) throw invalid('campaignId');
    if (input.campaignId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.campaignId)) throw invalid('campaignId');
    return this.repository.updateDemoSettings(actorId, input);
  }

  public listAudit(limit = 40): Promise<unknown> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('limit');
    return this.repository.listAudit(limit);
  }

  public updateAccountLimits(actorId: string, accountId: string, input: AccountLimitsInput): Promise<unknown> {
    assertRevision(input.expectedRevision);
    assertUnits(input.dailyCreditLimitUnits, 'dailyCreditLimitUnits');
    assertUnits(input.lifetimeCreditLimitUnits, 'lifetimeCreditLimitUnits');
    assertUnits(input.storageLimitBytes, 'storageLimitBytes');
    return this.repository.updateAccountLimits(actorId, accountId, input);
  }

  public setAccountEnabled(actorId: string, accountId: string, enabled: boolean): Promise<unknown> {
    if (typeof enabled !== 'boolean') throw invalid('enabled');
    return this.repository.setAccountEnabled(actorId, accountId, enabled);
  }

  public async resetPassword(actorId: string, accountId: string, password: string): Promise<void> {
    if (password.trim().length === 0 || password.length > 1024) throw invalid('password');
    await this.repository.resetPassword(actorId, accountId, await this.passwordHasher.hash(password));
  }

  public revokeSessions(actorId: string, accountId: string): Promise<void> {
    return this.repository.revokeSessions(actorId, accountId);
  }
}
