import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { IAgentRuntime, RuntimeCreateInput, RuntimeReadyResult } from '@/modules/ai-runs/repositories/agent-runtime';

/**
 * Keeps the runtime boundary explicit until a release-matched OpenShell SDK or CLI bridge is verified.
 */
export class UnsupportedOpenShellAgentRuntime implements IAgentRuntime {
  public async checkAvailability(): Promise<void> {
    throw new AiRunRuntimeUnavailableError();
  }

  public async create(_input: RuntimeCreateInput): Promise<RuntimeReadyResult> {
    throw new AiRunRuntimeUnavailableError();
  }

  public async destroy(_runId: string): Promise<void> {
    throw new AiRunRuntimeUnavailableError();
  }
}
