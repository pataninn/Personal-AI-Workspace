export type AccountLimitsInput = {
  readonly expectedRevision: number;
  readonly dailyCreditLimitUnits: string | null;
  readonly lifetimeCreditLimitUnits: string | null;
  readonly storageLimitBytes: string | null;
};

export type DemoSettingsInput = {
  readonly expectedRevision: number;
  readonly defaultDailyLimitUnits: string | null;
  readonly defaultLifetimeLimitUnits: string | null;
  readonly sessionTtlHours: number | null;
  readonly globalAdmissionMax: number | null;
  readonly globalAdmissionWindowSeconds: number | null;
  readonly networkAdmissionMax: number | null;
  readonly networkAdmissionWindowSeconds: number | null;
  readonly runStartMax: number | null;
  readonly runStartWindowSeconds: number | null;
  readonly maxConcurrentCalls: number;
  readonly globalDailyLimitUnits: string | null;
  readonly campaignId: string | null;
  readonly campaignLimitUnits: string | null;
  readonly inferencePaused: boolean;
};

export interface IAdminPortalRepository {
  listAccounts(search: string): Promise<unknown>;
  readCreditUsage(ownerId: string): Promise<unknown>;
  getDemoSettings(): Promise<unknown>;
  updateDemoSettings(actorId: string, input: DemoSettingsInput): Promise<unknown>;
  listAudit(limit: number): Promise<unknown>;
  createAccount(actorId: string, input: { readonly displayName: string; readonly identifier: string; readonly passwordHash: string }): Promise<unknown>;
  updateAccountLimits(actorId: string, accountId: string, input: AccountLimitsInput): Promise<unknown>;
  setAccountEnabled(actorId: string, accountId: string, enabled: boolean): Promise<unknown>;
  resetPassword(actorId: string, accountId: string, passwordHash: string): Promise<void>;
  revokeSessions(actorId: string, accountId: string): Promise<void>;
}
