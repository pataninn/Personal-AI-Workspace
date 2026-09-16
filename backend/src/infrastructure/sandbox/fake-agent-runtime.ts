import { createHash } from 'node:crypto';

import type { CommandResult } from '@/modules/ai-runs/domain/command-types';
import type {
  IAgentRuntime,
  RuntimeCommandCancellationInput,
  RuntimeCommandInput,
  RuntimeCommandProposalInput,
  RuntimeCreateInput,
  RuntimeReadyResult
} from '@/modules/ai-runs/repositories/agent-runtime';

export interface FakeRuntimeCommandOptions {
  readonly delayMs?: number;
  readonly nextResult?: CommandResult;
}

export class FakeAgentRuntime implements IAgentRuntime {
  public readonly availabilityChecks: string[] = [];
  public readonly createdRuns: RuntimeCreateInput[] = [];
  public readonly proposedCommands: RuntimeCommandProposalInput[] = [];
  public readonly executedCommands: RuntimeCommandInput[] = [];
  public readonly cancelledCommands: RuntimeCommandCancellationInput[] = [];
  public readonly destroyedRuns: string[] = [];
  public commandOptions: FakeRuntimeCommandOptions = {};
  private readonly cancelled = new Set<string>();

  public async checkAvailability(): Promise<void> {
    this.availabilityChecks.push('checked');
  }

  public async create(input: RuntimeCreateInput): Promise<RuntimeReadyResult> {
    this.createdRuns.push(input);
    return { kind: 'fake', sandboxReady: true };
  }

  public async proposeCommand(input: RuntimeCommandProposalInput): Promise<void> {
    this.proposedCommands.push(input);
  }

  public async executeCommand(input: RuntimeCommandInput): Promise<CommandResult> {
    this.executedCommands.push(input);
    await wait(this.commandOptions.delayMs ?? 0);
    if (this.cancelled.has(commandKey(input))) {
      return cancelledResult();
    }
    return this.commandOptions.nextResult ?? completedResult(input);
  }

  public async cancelCommand(input: RuntimeCommandCancellationInput): Promise<void> {
    this.cancelled.add(commandKey(input));
    this.cancelledCommands.push(input);
  }

  public async destroy(runId: string): Promise<void> {
    this.destroyedRuns.push(runId);
  }
}

function commandKey(input: { readonly runId: string; readonly commandId: string }): string {
  return `${input.runId}:${input.commandId}`;
}

function completedResult(input: RuntimeCommandInput): CommandResult {
  const output = `fake sandbox command: ${input.command}`;
  const outputBytes = Buffer.byteLength(output, 'utf8');
  const outputTruncated = outputBytes > input.limits.maxOutputBytes;
  const boundedBytes = Math.min(outputBytes, input.limits.maxOutputBytes);
  return {
    exitCode: 0,
    termination: outputTruncated ? 'output_truncated' : 'completed',
    durationMs: 1,
    outputBytes: boundedBytes,
    outputLineCount: 1,
    outputTruncated,
    outputSha256: createHash('sha256').update(output, 'utf8').digest('hex'),
    outputPreview: output.slice(0, 4 * 1024)
  };
}

function cancelledResult(): CommandResult {
  return {
    exitCode: null,
    termination: 'cancelled',
    durationMs: 1,
    outputBytes: 0,
    outputLineCount: 0,
    outputTruncated: false,
    outputSha256: createHash('sha256').update('', 'utf8').digest('hex'),
    outputPreview: ''
  };
}

async function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
