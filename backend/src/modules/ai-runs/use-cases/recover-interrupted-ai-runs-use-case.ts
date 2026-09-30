import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';

/** Moves saved in-flight runs to manual review; it never resumes provider work. */
export class RecoverInterruptedAiRunsUseCase {
  public constructor(private readonly repository: IAiRunRepository) {}

  public execute(): Promise<number> {
    return this.repository.recoverInterruptedRunsForReview?.() ?? Promise.resolve(0);
  }
}
