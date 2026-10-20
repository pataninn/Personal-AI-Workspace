import type { ICreditLedgerRepository } from '@/modules/credits/repositories/credit-ledger-repository';
import type { HomeTurnProviderUsageHistory, IHomeTurnProviderUsageHistory, ProviderCallUsageReceipt } from '@/modules/credits/repositories/provider-call-usage-history';

export class GetHomeTurnProviderUsageUseCase implements IHomeTurnProviderUsageHistory {
  public constructor(private readonly ledger: Pick<ICreditLedgerRepository, 'listHomeTurnProviderCallUsage'>) {}

  public async getForHomeTurn(ownerId: string, homeTurnId: string): Promise<HomeTurnProviderUsageHistory> {
    const rows = await this.ledger.listHomeTurnProviderCallUsage(ownerId, homeTurnId);
    if (rows.length > 32) throw new Error('The Home turn provider usage history exceeds its call bound.');
    if (!rows.length) return { state: 'unknown', calls: [] };
    const calls: ProviderCallUsageReceipt[] = [];
    let hasReleased = false;
    let incomplete = false;
    for (const row of rows) {
      if (row.status === 'released') {
        hasReleased = true;
        continue;
      }
      if (row.status === 'in_flight') {
        incomplete = true;
        calls.push({ status: 'pending', providerProfile: row.providerProfile, model: row.model, inputTokens: null, outputTokens: null, chargedUnits: null });
      } else if (row.status === 'unknown') {
        incomplete = true;
        calls.push({ status: 'unknown', providerProfile: row.providerProfile, model: row.model, inputTokens: null, outputTokens: null, chargedUnits: null });
      } else if (!row.usage) {
        incomplete = true;
        calls.push({ status: 'unknown', providerProfile: row.providerProfile, model: row.model, inputTokens: null, outputTokens: null, chargedUnits: null });
      } else {
        calls.push({
          status: row.status,
          providerProfile: row.providerProfile,
          model: row.model,
          inputTokens: row.usage.inputTokens,
          outputTokens: row.usage.outputTokens,
          chargedUnits: row.usage.chargedUnits
        });
      }
    }
    if (!calls.length && hasReleased) return { state: 'not_started', calls: [] };
    if (calls.some((call) => call.status === 'unknown')) return { state: 'unknown', calls };
    if (calls.some((call) => call.status === 'pending')) return { state: 'pending', calls };
    return { state: incomplete ? 'unknown' : 'settled', calls };
  }
}
