import type { ReadinessFailure, ReadinessSnapshot } from '@/modules/health/domain/readiness';
import type { IReadinessState } from '@/modules/health/repositories/readiness-state';

export class InMemoryReadinessState implements IReadinessState {
  private snapshot: ReadinessSnapshot = {
    status: 'not_ready',
    failures: []
  };

  public getSnapshot(): ReadinessSnapshot {
    return this.snapshot;
  }

  public markReady(): void {
    this.snapshot = { status: 'ready', failures: [] };
  }

  public markFailed(failures: readonly ReadinessFailure[]): void {
    this.snapshot = { status: 'not_ready', failures: [...failures] };
  }
}
