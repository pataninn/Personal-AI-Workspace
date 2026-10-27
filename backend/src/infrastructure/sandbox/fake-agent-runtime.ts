import { createHash } from 'node:crypto';

import type { CommandResult } from '@/modules/ai-runs/domain/command-types';
import type {
  IAgentRuntime,
  RuntimeCommandCancellationInput,
  RuntimeCommandInput,
  RuntimeCommandProposalInput,
  RuntimeCreateInput,
  RuntimeInferenceEvent,
  RuntimeRunCancellationInput,
  RuntimeRunCancellationResult,
  RuntimeRunInput,
  RuntimeReadyResult
} from '@/modules/ai-runs/repositories/agent-runtime';
import type { RuntimeChangeProposal } from '@/modules/ai-runs/domain/change-types';

export interface FakeRuntimeCommandOptions {
  readonly delayMs?: number;
  readonly nextResult?: CommandResult;
}

export interface FakeRuntimeRunOptions {
  readonly response?: string;
  readonly deltaSize?: number;
  readonly delayMs?: number;
  readonly events?: readonly RuntimeInferenceEvent[];
  readonly cancelOutcome?: RuntimeRunCancellationResult['outcome'];
  readonly proposedChanges?: readonly RuntimeChangeProposal[];
}

export class FakeAgentRuntime implements IAgentRuntime {
  public readonly availabilityChecks: string[] = [];
  public readonly createdRuns: RuntimeCreateInput[] = [];
  public readonly proposedCommands: RuntimeCommandProposalInput[] = [];
  public readonly executedCommands: RuntimeCommandInput[] = [];
  public readonly policyExecutedCommands: RuntimeCommandInput[] = [];
  public readonly cancelledCommands: RuntimeCommandCancellationInput[] = [];
  public readonly startedRuns: RuntimeRunInput[] = [];
  public readonly cancelledRuns: RuntimeRunCancellationInput[] = [];
  public readonly destroyedRuns: string[] = [];
  public commandOptions: FakeRuntimeCommandOptions = {};
  public runOptions: FakeRuntimeRunOptions = {};
  private readonly cancelled = new Set<string>();
  private readonly cancelledRunsSet = new Set<string>();

  public async checkAvailability(): Promise<void> {
    this.availabilityChecks.push('checked');
  }

  public async supportsPolicyCommandExecution(): Promise<boolean> { return true; }

  public async create(input: RuntimeCreateInput): Promise<RuntimeReadyResult> {
    this.createdRuns.push(input);
    return { kind: 'fake', sandboxReady: true };
  }

  public async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeInferenceEvent> {
    this.startedRuns.push(input);
    const configured = this.runOptions.events;
    if (configured) {
      for (const event of configured) {
        if (this.cancelledRunsSet.has(input.runId)) {
          yield { type: 'cancelled' };
          return;
        }
        await wait(this.runOptions.delayMs ?? 0);
        yield event;
      }
      return;
    }
    yield { type: 'started' };
    if (this.runOptions.proposedChanges && this.runOptions.proposedChanges.length > 0) {
      yield { type: 'changes.proposed', changes: this.runOptions.proposedChanges };
    }
    const response = this.runOptions.response ?? `Fake response for: ${input.request}`;
    const deltaSize = Math.max(1, this.runOptions.deltaSize ?? 32);
    for (let offset = 0; offset < response.length; offset += deltaSize) {
      if (this.cancelledRunsSet.has(input.runId)) {
        yield { type: 'cancelled' };
        return;
      }
      await wait(this.runOptions.delayMs ?? 0);
      yield { type: 'assistant.delta', text: response.slice(offset, offset + deltaSize) };
    }
    if (this.cancelledRunsSet.has(input.runId)) {
      yield { type: 'cancelled' };
      return;
    }
    yield { type: 'assistant.message.completed', text: response };
    yield { type: 'completed', text: response };
  }

  public async cancelRun(input: RuntimeRunCancellationInput): Promise<RuntimeRunCancellationResult> {
    this.cancelledRunsSet.add(input.runId);
    this.cancelledRuns.push(input);
    return { outcome: this.runOptions.cancelOutcome ?? 'confirmed' };
  }

  public async proposeCommand(input: RuntimeCommandProposalInput): Promise<void> {
    this.proposedCommands.push(input);
  }

  public async executeCommand(input: RuntimeCommandInput): Promise<CommandResult> {
    this.executedCommands.push(input);
    return this.runCommand(input);
  }

  public async executePolicyCommand(input: RuntimeCommandInput): Promise<CommandResult> {
    this.policyExecutedCommands.push(input);
    return this.runCommand(input);
  }

  private async runCommand(input: RuntimeCommandInput): Promise<CommandResult> {
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
