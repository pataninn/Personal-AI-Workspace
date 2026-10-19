export interface DemoExpiryCancellationPort {
  cancelRun(input: { readonly ownerId: string; readonly runId: string; readonly idempotencyKey: string }): Promise<unknown>;
  cancelCommand(input: {
    readonly ownerId: string;
    readonly runId: string;
    readonly commandId: string;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
}

export interface IDemoExpiryCleanupRepository {
  runBatch(cancellation: DemoExpiryCancellationPort, limit?: number): Promise<number>;
}
