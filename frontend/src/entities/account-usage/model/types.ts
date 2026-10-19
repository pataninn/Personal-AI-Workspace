export interface CreditUsage {
  readonly limitUnits: string | null;
  readonly settledUnits: string;
  readonly reservedUnits: string;
  readonly remainingUnits: string | null;
  readonly resetAt?: string;
  readonly timeZone?: string;
}

export interface AccountStorageUsage {
  readonly state: 'reconciling' | 'ready' | 'unavailable';
  readonly unit: 'bytes';
  readonly unitSystem: 'decimal-si';
  readonly usedBytes: string | null;
  readonly reservedBytes: string | null;
  readonly limitBytes: string | null;
  readonly availableBytes: string | null;
  readonly overLimit: boolean | null;
  readonly asOf: string | null;
}

export interface AccountUsageSnapshot {
  readonly asOf: string;
  readonly expiresAt: string | null;
  readonly daily: CreditUsage & { readonly resetAt: string; readonly timeZone: string };
  readonly lifetime: CreditUsage;
  readonly storage: AccountStorageUsage;
  readonly availability: {
    readonly status: 'available' | 'exhausted' | 'paused' | 'unknown';
    readonly reason: string | null;
    readonly canSubmit: boolean;
  };
}

export type AccountUsageState =
  | { readonly status: 'loading'; readonly data: null }
  | { readonly status: 'error'; readonly data: null }
  | { readonly status: 'success'; readonly data: AccountUsageSnapshot };
