import type { EgressManifest } from '@/modules/ai-runs/domain/ai-run-types';

export interface RuntimeCreateInput {
  readonly runId: string;
  readonly stagedReference: string;
  readonly manifest: EgressManifest;
}

export interface RuntimeReadyResult {
  readonly kind: 'fake';
  readonly sandboxReady: true;
}

export interface IAgentRuntime {
  checkAvailability(): Promise<void>;
  create(input: RuntimeCreateInput): Promise<RuntimeReadyResult>;
  destroy(runId: string): Promise<void>;
}
