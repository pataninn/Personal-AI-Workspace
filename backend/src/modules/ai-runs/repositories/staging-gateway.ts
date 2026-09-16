import type { EgressFileEntry, EgressMessage } from '@/modules/ai-runs/domain/ai-run-types';

export interface StageInput {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly relativeRoot: string;
  readonly request: string;
  readonly files: readonly EgressFileEntry[];
  readonly messages: readonly EgressMessage[];
}

export interface StageResult {
  readonly stagingReference: string;
  readonly itemCount: number;
}

export interface IStagingGateway {
  stage(input: StageInput): Promise<StageResult>;
  cleanup(stagingReference: string): Promise<void>;
}
