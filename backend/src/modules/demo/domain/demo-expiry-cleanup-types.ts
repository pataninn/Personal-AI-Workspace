export interface DemoExpiryCancellationPort {
  cancelRun(input: { readonly ownerId: string; readonly runId: string; readonly idempotencyKey: string }): Promise<unknown>;
  cancelCommand(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly commandId: string;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
  cancelAutomationTurn(input: { readonly ownerId: string; readonly conversationId: string; readonly turnId: string }): Promise<{ readonly status: string }>;
  /** Trusted cleanup-only path; expiry has already fenced the owner from new work. */
  cancelHomeTurn?(input: { readonly ownerId: string; readonly conversationId: string; readonly turnId: string }): Promise<{ readonly status: string }>;
}

export interface IDemoExpiryCleanupRepository {
  runBatch(cancellation: DemoExpiryCancellationPort, limit?: number): Promise<number>;
}
