import type { IDemoExpiryCleanupRepository } from '@/modules/demo/domain/demo-expiry-cleanup-types';
import type { CancelAiRunUseCase } from '@/modules/ai-runs/use-cases/cancel-ai-run-use-case';
import type { CancelSandboxCommandUseCase } from '@/modules/ai-runs/use-cases/sandbox-command-use-cases';
import type { CancelHomeTurnUseCase } from '@/modules/home-assistant/use-cases/cancel-home-turn';

/** Runs one bounded pass; authorization expiry itself remains immediate and independent. */
export class CleanupExpiredDemosUseCase {
  public constructor(
    private readonly cleanup: IDemoExpiryCleanupRepository,
    private readonly cancelAiRun: CancelAiRunUseCase,
    private readonly cancelSandboxCommand: CancelSandboxCommandUseCase,
    private readonly cancelHomeTurn?: CancelHomeTurnUseCase
  ) {}

  public async execute(): Promise<number> {
    return this.cleanup.runBatch({
      cancelRun: async (input) => { await this.cancelAiRun.execute(input); },
      cancelCommand: async (input) => { await this.cancelSandboxCommand.execute(input); },
      cancelAutomationTurn: async (input) => {
        if (!this.cancelHomeTurn) throw new Error('The scheduled Home turn cancellation path is unavailable.');
        return this.cancelHomeTurn.cancelForExpiry(input);
      },
      cancelHomeTurn: async (input) => {
        if (!this.cancelHomeTurn) throw new Error('The Home turn cancellation path is unavailable.');
        return this.cancelHomeTurn.cancelForExpiry(input);
      }
    });
  }
}
