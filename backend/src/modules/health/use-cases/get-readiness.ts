import type { ReadinessSnapshot } from '@/modules/health/domain/readiness';
import type { IReadinessState } from '@/modules/health/repositories/readiness-state';

export class GetReadinessUseCase {
  private readonly readinessState: IReadinessState;

  public constructor(readinessState: IReadinessState) {
    this.readinessState = readinessState;
  }

  public execute(): ReadinessSnapshot {
    return this.readinessState.getSnapshot();
  }
}
