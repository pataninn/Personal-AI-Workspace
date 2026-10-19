import type { IDemoExpiryCleanupRepository } from '@/modules/demo/domain/demo-expiry-cleanup-types';
import type { CancelAiRunUseCase } from '@/modules/ai-runs/use-cases/cancel-ai-run-use-case';
import type { CancelSandboxCommandUseCase } from '@/modules/ai-runs/use-cases/sandbox-command-use-cases';

/** Runs one bounded pass; authorization expiry itself remains immediate and independent. */
export class CleanupExpiredDemosUseCase {
  public constructor(
    private readonly cleanup: IDemoExpiryCleanupRepository,
    private readonly cancelAiRun: CancelAiRunUseCase,
    private readonly cancelSandboxCommand: CancelSandboxCommandUseCase
  ) {}

  public async execute(): Promise<number> {
    return this.cleanup.runBatch({
      cancelRun: async (input) => { await this.cancelAiRun.execute(input); },
      cancelCommand: async (input) => { await this.cancelSandboxCommand.execute(input); }
    });
  }
}
