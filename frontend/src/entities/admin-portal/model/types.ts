export interface AdminCreditSummary {
  readonly limitUnits: string | null;
  readonly settledUnits: string;
  readonly reservedUnits: string;
  readonly remainingUnits: string | null;
}

export interface AdminAccountSummary {
  readonly id: string;
  readonly displayName: string;
  readonly identifier: string | null;
  readonly accountKind: 'regular' | 'demo';
  readonly role: 'user' | 'admin';
  readonly enabled: boolean;
  readonly expiresAt: string | null;
  readonly limitsRevision: number;
  readonly daily: AdminCreditSummary;
  readonly lifetime: AdminCreditSummary;
  readonly storage: {
    readonly state: 'ready' | 'reconciling' | 'unavailable';
    readonly usedBytes: string | null;
    readonly reservedBytes: string | null;
    readonly limitBytes: string | null;
    readonly overLimit: boolean | null;
  };
  readonly canDisable: boolean;
  readonly disableReason: string | null;
}

export interface AdminDemoSettings {
  readonly revision: number;
  readonly demoSettingsBootstrapped: boolean;
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
  readonly usage: { readonly dailySettledUnits: string; readonly dailyReservedUnits: string; readonly campaignSettledUnits: string; readonly campaignReservedUnits: string; readonly dailyTimeZone: string };
}

export type AdminDemoSettingsUpdate = Omit<AdminDemoSettings, 'revision' | 'demoSettingsBootstrapped' | 'usage'> & {
  readonly expectedRevision: number;
};

export interface AdminAuditEvent {
  readonly id: string;
  readonly actorName: string | null;
  readonly action: string;
  readonly target_account_id: string | null;
  readonly old_values: Record<string, unknown>;
  readonly new_values: Record<string, unknown>;
  readonly createdAt: string;
}
