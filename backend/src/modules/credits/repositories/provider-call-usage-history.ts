export type ProviderCallUsageReceiptStatus = 'pending' | 'unknown' | 'settled' | 'over_bound';

export interface ProviderCallUsageReceipt {
  readonly status: ProviderCallUsageReceiptStatus;
  readonly providerProfile: string;
  readonly model: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly chargedUnits: string | null;
  readonly estimated?: true;
}

export interface HomeTurnProviderUsageHistory {
  readonly state: 'not_started' | 'settled' | 'pending' | 'unknown';
  readonly calls: readonly ProviderCallUsageReceipt[];
}

/** Owner-scoped historical usage projection for a persisted Home turn. */
export interface IHomeTurnProviderUsageHistory {
  getForHomeTurn(ownerId: string, homeTurnId: string): Promise<HomeTurnProviderUsageHistory>;
}
