import { AiRunStagingFailedError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { IStagingGateway, StageInput, StageResult } from '@/modules/ai-runs/repositories/staging-gateway';

export class FakeStagingGateway implements IStagingGateway {
  public readonly staged: StageInput[] = [];
  public readonly cleaned: string[] = [];
  public shouldFail = false;
  public cleanupShouldFail = false;

  public async stage(input: StageInput): Promise<StageResult> {
    if (this.shouldFail) {
      throw new AiRunStagingFailedError(this.cleanupShouldFail ? 'unknown' : 'complete');
    }
    this.staged.push(input);
    return { stagingReference: `fake://${input.runId}`, itemCount: input.files.length + 1 };
  }

  public async cleanup(stagingReference: string): Promise<void> {
    if (this.cleanupShouldFail) {
      throw new AiRunStagingFailedError('unknown');
    }
    this.cleaned.push(stagingReference);
  }

  public async assertFresh(_stagingReference: string): Promise<void> {
    return undefined;
  }

  public async cleanupExpired(): Promise<number> {
    return 0;
  }
}
