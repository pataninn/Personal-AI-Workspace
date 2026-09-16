import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';
import {
  SandboxCommandNotFoundError,
  SandboxCommandProjectArchivedError,
  SandboxCommandReviewRequiredError,
  SandboxCommandRunNotReadyError,
  SandboxCommandValidationError
} from '@/modules/ai-runs/domain/command-errors';
import { normalizeCommandProposal, summarizeArgument } from '@/modules/ai-runs/domain/command-policy';
import type {
  CommandResult,
  CommandResultUpdate,
  CreateSandboxCommandRecord,
  SandboxCommand,
  CommandSnapshot
} from '@/modules/ai-runs/domain/command-types';
import { MAX_SANDBOX_COMMANDS_PER_LIST } from '@/modules/ai-runs/domain/command-types';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IAgentRuntime } from '@/modules/ai-runs/repositories/agent-runtime';
import type { ISandboxCommandRepository } from '@/modules/ai-runs/repositories/sandbox-command-repository';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { hashText } from '@/modules/ai-runs/use-cases/manifest-builder';
import { validateIdempotencyKey } from '@/modules/ai-runs/domain/ai-run-validation';
import { sanitizeCommandResult } from '@/modules/ai-runs/domain/command-result';

export interface SandboxCommandLogger {
  readonly error: (context: { readonly commandId: string }, message: string) => void;
}

export interface ProposeSandboxCommandInput {
  readonly ownerId: string;
  readonly runId: string;
  readonly command: unknown;
  readonly args: unknown;
  readonly cwd?: unknown;
  readonly summary?: unknown;
  readonly idempotencyKey: string;
}

export interface ProposeSandboxCommandOutput {
  readonly resource: SandboxCommand;
  readonly replayed: boolean;
}

export class ProposeSandboxCommandUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly commandRepository: ISandboxCommandRepository,
    private readonly agentRuntime: IAgentRuntime,
    private readonly projectRepository: IProjectRepository,
    private readonly logger?: SandboxCommandLogger
  ) {}

  public async execute(input: ProposeSandboxCommandInput): Promise<ProposeSandboxCommandOutput> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new SandboxCommandNotFoundError();
    }
    await assertActiveProject(this.projectRepository, input.ownerId, run.projectId);
    assertReadyRun(run);
    if (!this.agentRuntime.proposeCommand) {
      throw new AiRunRuntimeUnavailableError();
    }
    const proposal = normalizeCommandProposal({ command: input.command, args: input.args, cwd: input.cwd, summary: input.summary });
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const record: CreateSandboxCommandRecord = {
      ownerId: input.ownerId,
      projectId: run.projectId,
      runId: run.id,
      proposalHash: proposal.proposalHash,
      command: proposal.command,
      args: proposal.args,
      cwd: proposal.cwd,
      summary: proposal.summary,
      classification: proposal.classification,
      ...(proposal.blockedReason ? { blockedReason: proposal.blockedReason } : {}),
      limits: proposal.limits,
      createIdempotencyKey: idempotencyKey,
      createFingerprint: proposal.createFingerprint
    };
    const created = await this.commandRepository.createProposal(record);
    if (!created.replayed && proposal.classification !== 'blocked') {
      try {
        await this.agentRuntime.proposeCommand({ runId: run.id, commandId: created.resource.id, command: proposal.command, args: proposal.args, cwd: proposal.cwd });
      } catch (error: unknown) {
        try {
          await this.commandRepository.saveIfAwaiting({ ownerId: input.ownerId, runId: run.id, commandId: created.resource.id, status: 'review_required', safeMessage: 'The command proposal could not be confirmed. Refresh command status before retrying.' });
        } catch {
          this.logPersistenceFailure(created.resource.id, 'Sandbox command proposal failure could not be persisted.');
        }
        throw error;
      }
    }
    return created;
  }

  private logPersistenceFailure(commandId: string, message: string): void {
    this.logger?.error({ commandId }, message);
  }
}

export class ListSandboxCommandsUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly commandRepository: ISandboxCommandRepository
  ) {}

  public async execute(input: { readonly ownerId: string; readonly runId: string }): Promise<readonly SandboxCommand[]> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new SandboxCommandNotFoundError();
    }
    return this.commandRepository.listForRun(input.ownerId, input.runId, MAX_SANDBOX_COMMANDS_PER_LIST);
  }
}

export class GetSandboxCommandUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly commandRepository: ISandboxCommandRepository
  ) {}

  public async execute(input: { readonly ownerId: string; readonly runId: string; readonly commandId: string }): Promise<SandboxCommand> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new SandboxCommandNotFoundError();
    }
    const command = await this.commandRepository.findByIdForOwner(input.ownerId, input.runId, input.commandId);
    if (!command) {
      throw new SandboxCommandNotFoundError();
    }
    return command;
  }
}

export interface DecideSandboxCommandInput {
  readonly ownerId: string;
  readonly runId: string;
  readonly commandId: string;
  readonly proposalHash: unknown;
  readonly decision: unknown;
  readonly idempotencyKey: string;
}

export class DecideSandboxCommandUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly commandRepository: ISandboxCommandRepository,
    private readonly agentRuntime: IAgentRuntime,
    private readonly projectRepository: IProjectRepository,
    private readonly logger?: SandboxCommandLogger
  ) {}

  public async execute(input: DecideSandboxCommandInput): Promise<SandboxCommand> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new SandboxCommandNotFoundError();
    }
    await assertActiveProject(this.projectRepository, input.ownerId, run.projectId);
    assertReadyRun(run);
    const command = await this.getCommand(input.ownerId, input.runId, input.commandId);
    const proposalHash = validateProposalHash(input.proposalHash);
    const decision = validateCommandDecision(input.decision);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = hashText(JSON.stringify({ proposalHash, decision }));
    await assertActiveProject(this.projectRepository, input.ownerId, run.projectId);
    const result = await this.commandRepository.recordDecision({ ownerId: input.ownerId, runId: input.runId, commandId: command.id, proposalHash, decision, idempotencyKey, requestFingerprint });
    if (result.replayed || decision === 'reject') {
      return result.resource;
    }
    try {
      await this.agentRuntime.checkAvailability();
    } catch (error: unknown) {
      await this.persistAwaitingFailure(input.ownerId, input.runId, command.id, 'The private sandbox was unavailable. No command was run.');
      throw error;
    }
    const running = await this.commandRepository.markRunning(input.ownerId, input.runId, command.id);
    if (!running || running.status !== 'running') {
      return running ?? result.resource;
    }
    const current = await this.commandRepository.findByIdForOwner(input.ownerId, input.runId, command.id);
    if (!current || current.status !== 'running' || current.cancelRequested) {
      return current ?? running;
    }
    return this.executeInRuntime(run.id, current);
  }

  private async executeInRuntime(runId: string, command: SandboxCommand): Promise<SandboxCommand> {
    try {
      if (command.cancelRequested || command.status !== 'running') {
        return command;
      }
      if (!this.agentRuntime.executeCommand) {
        throw new AiRunRuntimeUnavailableError();
      }
      const current = await this.commandRepository.findByIdForOwner(command.ownerId, runId, command.id);
      if (!current || current.status !== 'running' || current.cancelRequested) {
        return current ?? command;
      }
      const result = await this.agentRuntime.executeCommand({ runId, commandId: command.id, command: command.command, args: command.args, cwd: command.cwd, limits: command.limits });
      const saved = await this.commandRepository.saveExecutionResult(resultUpdate(command.ownerId, runId, command.id, sanitizeCommandResult(result, command.limits)));
      if (saved) {
        return saved;
      }
      const latest = await this.commandRepository.findByIdForOwner(command.ownerId, runId, command.id);
      if (latest?.status === 'cancel_requested' || latest?.cancelRequested) {
        return this.commandRepository.saveResult({ ownerId: command.ownerId, runId, commandId: command.id, status: 'cancelled', safeMessage: 'Command cancelled. No result was promoted to the project.' });
      }
      return latest ?? command;
    } catch (error: unknown) {
      if (error instanceof AiRunRuntimeUnavailableError) {
        return this.persistExecutionFailure(command, runId, 'failed', 'The private sandbox was unavailable. No command was run.');
      }
      return this.persistExecutionFailure(command, runId, 'review_required', 'Command status could not be confirmed. Refresh command status before retrying.');
    }
  }

  private async persistExecutionFailure(command: SandboxCommand, runId: string, status: 'failed' | 'review_required', safeMessage: string): Promise<SandboxCommand> {
    try {
      const saved = await this.commandRepository.saveExecutionResult({ ownerId: command.ownerId, runId, commandId: command.id, status, safeMessage });
      if (saved) {
        return saved;
      }
      const latest = await this.commandRepository.findByIdForOwner(command.ownerId, runId, command.id);
      if (latest?.status === 'cancel_requested' || latest?.cancelRequested) {
        return this.commandRepository.saveResult({ ownerId: command.ownerId, runId, commandId: command.id, status: 'cancelled', safeMessage: 'Command cancelled. No result was promoted to the project.' });
      }
      return latest ?? this.reviewFallback(command);
    } catch {
      this.logPersistenceFailure(command.id, 'Sandbox command result persistence failed; manual review is required.');
      return this.reviewFallback(command);
    }
  }

  private async persistAwaitingFailure(ownerId: string, runId: string, commandId: string, safeMessage: string): Promise<void> {
    try {
      await this.commandRepository.saveIfAwaiting({ ownerId, runId, commandId, status: 'failed', safeMessage });
    } catch {
      this.logPersistenceFailure(commandId, 'Sandbox command preflight failure could not be persisted.');
    }
  }

  private logPersistenceFailure(commandId: string, message: string): void {
    this.logger?.error({ commandId }, message);
  }

  private reviewFallback(command: SandboxCommand): SandboxCommand {
    return { ...command, status: 'review_required', safeMessage: 'Command status could not be confirmed. Refresh command status before retrying.', updatedAt: new Date() };
  }

  private async getCommand(ownerId: string, runId: string, commandId: string): Promise<SandboxCommand> {
    const command = await this.commandRepository.findByIdForOwner(ownerId, runId, commandId);
    if (!command) {
      throw new SandboxCommandNotFoundError();
    }
    return command;
  }
}

export interface CancelSandboxCommandInput {
  readonly ownerId: string;
  readonly runId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
}

export class CancelSandboxCommandUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly commandRepository: ISandboxCommandRepository,
    private readonly agentRuntime: IAgentRuntime,
    private readonly projectRepository: IProjectRepository,
    private readonly logger?: SandboxCommandLogger
  ) {}

  public async execute(input: CancelSandboxCommandInput): Promise<SandboxCommand> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new SandboxCommandNotFoundError();
    }
    await assertActiveProject(this.projectRepository, input.ownerId, run.projectId);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    const requestFingerprint = hashText(JSON.stringify({ commandId: input.commandId, action: 'cancel' }));
    const result = await this.commandRepository.recordCancellation({ ownerId: input.ownerId, runId: input.runId, commandId: input.commandId, idempotencyKey, requestFingerprint });
    if (result.replayed || result.resource.status !== 'cancel_requested') {
      return result.resource;
    }
    if (!this.agentRuntime.cancelCommand) {
      await this.persistCancellationReview(input.ownerId, input.runId, input.commandId);
      throw new SandboxCommandReviewRequiredError();
    }
    try {
      await this.agentRuntime.cancelCommand({ runId: input.runId, commandId: input.commandId });
    } catch (error: unknown) {
      if (error instanceof AiRunRuntimeUnavailableError) {
        await this.persistCancellationReview(input.ownerId, input.runId, input.commandId);
        throw new SandboxCommandReviewRequiredError();
      }
      await this.persistCancellationReview(input.ownerId, input.runId, input.commandId);
      throw new SandboxCommandReviewRequiredError();
    }
    return (await this.commandRepository.findByIdForOwner(input.ownerId, input.runId, input.commandId)) ?? result.resource;
  }

  private async persistCancellationReview(ownerId: string, runId: string, commandId: string): Promise<void> {
    try {
      await this.commandRepository.saveResult({ ownerId, runId, commandId, status: 'review_required', safeMessage: 'Command status could not be confirmed. Refresh command status before retrying.' });
    } catch {
      this.logger?.error({ commandId }, 'Sandbox command cancellation persistence failed; manual review is required.');
    }
  }
}

export function toCommandSnapshot(command: SandboxCommand): CommandSnapshot {
  return {
    commandId: command.id,
    runId: command.runId,
    proposalHash: command.proposalHash,
    command: command.command,
    summary: command.summary,
    argumentCount: command.args.length,
    argumentSummaries: command.args.map(summarizeArgument),
    cwd: command.cwd,
    classification: command.classification,
    decision: command.decision,
    status: command.status,
    runtimeKind: 'fake',
    limits: command.limits,
    ...(command.result ? { result: sanitizeCommandResult(command.result, command.limits) } : {}),
    safeMessage: command.safeMessage,
    createdAt: command.createdAt.toISOString(),
    updatedAt: command.updatedAt.toISOString()
  };
}

function assertReadyRun(run: { readonly status: string; readonly decision: string; readonly sandboxReady: boolean }): void {
  if (!['ready', 'queued', 'running', 'waiting_approval'].includes(run.status) || run.decision !== 'approved' || !run.sandboxReady) {
    throw new SandboxCommandRunNotReadyError();
  }
}

async function assertActiveProject(projectRepository: IProjectRepository, ownerId: string, projectId: string): Promise<void> {
  const project = await projectRepository.findByIdForOwner(ownerId, projectId);
  if (!project) {
    throw new SandboxCommandNotFoundError();
  }
  if (project.status === 'archived') {
    throw new SandboxCommandProjectArchivedError();
  }
}

function validateProposalHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new SandboxCommandValidationError([{ field: 'proposalHash', message: 'Proposal hash must be a SHA-256 hexadecimal value.' }]);
  }
  return value;
}

function validateCommandDecision(value: unknown): 'approve' | 'reject' {
  if (value !== 'approve' && value !== 'reject') {
    throw new SandboxCommandValidationError([{ field: 'decision', message: 'Decision must be approve or reject.' }]);
  }
  return value;
}

function resultUpdate(ownerId: string, runId: string, commandId: string, result: CommandResult): CommandResultUpdate {
  const status = result.termination === 'completed'
    ? 'completed'
    : result.termination === 'output_truncated'
      ? 'output_truncated'
      : result.termination === 'timed_out'
        ? 'timed_out'
        : result.termination === 'cancelled' ? 'cancelled' : 'failed';
  const safeMessage = status === 'completed'
    ? 'Command completed in the private sandbox.'
    : status === 'output_truncated'
      ? 'Command completed with output truncated by the sandbox limit.'
      : status === 'timed_out'
        ? 'The command reached the private sandbox time limit.'
        : status === 'cancelled'
          ? 'Command cancelled. No result was promoted to the project.'
          : 'The command finished with an error in the private sandbox.';
  return { ownerId, runId, commandId, status, result, safeMessage };
}
