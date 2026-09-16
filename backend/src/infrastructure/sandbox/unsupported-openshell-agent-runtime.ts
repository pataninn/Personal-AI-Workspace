import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';
import type {
  IAgentRuntime,
  RuntimeCommandCancellationInput,
  RuntimeCommandInput,
  RuntimeCommandProposalInput,
  RuntimeCreateInput,
  RuntimeReadyResult
} from '@/modules/ai-runs/repositories/agent-runtime';
import type { CommandResult } from '@/modules/ai-runs/domain/command-types';

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

  public async proposeCommand(_input: RuntimeCommandProposalInput): Promise<void> {
    throw new AiRunRuntimeUnavailableError();
  }

  public async executeCommand(_input: RuntimeCommandInput): Promise<CommandResult> {
    throw new AiRunRuntimeUnavailableError();
  }

  public async cancelCommand(_input: RuntimeCommandCancellationInput): Promise<void> {
    throw new AiRunRuntimeUnavailableError();
  }

  public async destroy(_runId: string): Promise<void> {
    throw new AiRunRuntimeUnavailableError();
  }
}
