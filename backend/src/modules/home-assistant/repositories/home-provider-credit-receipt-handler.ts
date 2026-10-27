import type { HomeProviderCreditRequest, HomeProviderCreditResult } from '@/modules/home-assistant/repositories/home-planning-runtime';

/** Application boundary to the Credits module for one bridge-authenticated Home provider receipt. */
export interface IHomeProviderCreditReceiptHandler {
  handle(input: {
    readonly ownerId: string;
    readonly turnId: string;
    readonly providerProfile: string;
    readonly model: string;
    readonly request: HomeProviderCreditRequest;
  }): Promise<HomeProviderCreditResult>;
  hasAdmittedCall(turnId: string): boolean;
  markInterrupted(ownerId: string, turnId: string): Promise<void>;
  clearTurn(turnId: string): void;
}
