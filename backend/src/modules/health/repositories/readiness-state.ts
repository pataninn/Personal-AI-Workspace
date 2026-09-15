import type { ReadinessFailure, ReadinessSnapshot } from '@/modules/health/domain/readiness';

export interface IReadinessState {
  getSnapshot(): ReadinessSnapshot;
  markReady(): void;
  markFailed(failures: readonly ReadinessFailure[]): void;
}
