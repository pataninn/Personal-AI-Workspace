import type { IAgentRuntime, RuntimeCreateInput, RuntimeReadyResult } from '@/modules/ai-runs/repositories/agent-runtime';

export class FakeAgentRuntime implements IAgentRuntime {
  public readonly availabilityChecks: string[] = [];
  public readonly createdRuns: RuntimeCreateInput[] = [];
  public readonly destroyedRuns: string[] = [];

  public async checkAvailability(): Promise<void> {
    this.availabilityChecks.push('checked');
  }

  public async create(input: RuntimeCreateInput): Promise<RuntimeReadyResult> {
    this.createdRuns.push(input);
    return { kind: 'fake', sandboxReady: true };
  }

  public async destroy(runId: string): Promise<void> {
    this.destroyedRuns.push(runId);
  }
}
