export type ReadinessCheckName = 'database' | 'workspace' | 'openshell' | 'nim';

export interface ReadinessFailure {
  readonly check: ReadinessCheckName;
  readonly code: string;
  readonly message: string;
}

export interface ReadinessSnapshot {
  readonly status: 'ready' | 'not_ready';
  readonly failures: readonly ReadinessFailure[];
}
