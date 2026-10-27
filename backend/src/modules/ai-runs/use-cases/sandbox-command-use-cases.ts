import { AiRunRuntimeUnavailableError } from '@/modules/ai-runs/domain/ai-run-errors';
import {
  SandboxCommandNotFoundError,
  SandboxCommandProjectArchivedError,
  SandboxCommandReviewRequiredError,
  SandboxCommandRunNotReadyError,
  SandboxCommandValidationError
} from '@/modules/ai-runs/domain/command-errors';
import { normalizeCommandProposal, normalizeHermesPermission, normalizePolicyHermesPermission, summarizeArgument, summarizeHermesCommand } from '@/modules/ai-runs/domain/command-policy';
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
import { requireProjectFileRoot } from '@/modules/projects/domain/project-file-root';
import { hashText } from '@/modules/ai-runs/use-cases/manifest-builder';
import { validateIdempotencyKey } from '@/modules/ai-runs/domain/ai-run-validation';
import { sanitizeCommandResult } from '@/modules/ai-runs/domain/command-result';
import { assertAiRunProjectHasFileRoot } from '@/modules/ai-runs/use-cases/assert-ai-run-project';
import type { AssertAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import { AssistantExecutionPolicyChangedError, AssistantExecutionUnavailableError } from '@/modules/assistant-policy/domain/assistant-execution-errors';
import type { AiRun } from '@/modules/ai-runs/domain/ai-run-types';

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
    private readonly logger?: SandboxCommandLogger,
    private readonly executionPolicy?: Pick<AssertAssistantExecutionPolicyUseCase, 'assertWorkspace'>
  ) {}

  public async execute(input: ProposeSandboxCommandInput): Promise<ProposeSandboxCommandOutput> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new SandboxCommandNotFoundError();
    }
    await assertActiveProject(this.projectRepository, input.ownerId, run.projectId);
    const policyAuthorized = run.decision === 'policy_authorized';
    if (policyAuthorized) {
      if (!run.policyRevision || !this.executionPolicy) throw new AssistantExecutionUnavailableError();
      const authorization = await this.executionPolicy.assertWorkspace({ ownerId: run.ownerId, projectId: run.projectId, providerProfile: run.manifest.providerProfile, model: run.manifest.model, policyRevision: run.policyRevision });
      if (!authorization.effectiveCapabilities.includes('bounded_sandbox_command')) throw new AssistantExecutionUnavailableError();
    } else {
      assertReadyRun(run);
    }
    if (!this.agentRuntime.proposeCommand) {
      throw new AiRunRuntimeUnavailableError();
    }
    const proposal = policyAuthorized
      ? normalizePolicyHermesPermission({ command: input.command, args: input.args, cwd: input.cwd, summary: input.summary }, run.manifest.files.map((file) => file.relativePath), run.manifest.manifestHash)
      : run.runtimeKind === 'hermes'
        ? normalizeHermesPermission({ command: input.command, args: input.args, cwd: input.cwd, summary: input.summary })
        : normalizeCommandProposal({ command: input.command, args: input.args, cwd: input.cwd, summary: input.summary });
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
    if (!created.replayed && (proposal.classification !== 'blocked' || policyAuthorized)) {
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
    private readonly commandRepository: ISandboxCommandRepository,
    private readonly projectRepository: IProjectRepository
  ) {}

  public async execute(input: { readonly ownerId: string; readonly runId: string }): Promise<readonly SandboxCommand[]> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new SandboxCommandNotFoundError();
    }
    await assertAiRunProjectHasFileRoot(this.projectRepository, input.ownerId, run.projectId);
    return this.commandRepository.listForRun(input.ownerId, input.runId, MAX_SANDBOX_COMMANDS_PER_LIST);
  }
}

export class GetSandboxCommandUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly commandRepository: ISandboxCommandRepository,
    private readonly projectRepository: IProjectRepository
  ) {}

  public async execute(input: { readonly ownerId: string; readonly runId: string; readonly commandId: string }): Promise<SandboxCommand> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new SandboxCommandNotFoundError();
    }
    await assertAiRunProjectHasFileRoot(this.projectRepository, input.ownerId, run.projectId);
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
    private readonly logger?: SandboxCommandLogger,
    private readonly executionPolicy?: Pick<AssertAssistantExecutionPolicyUseCase, 'assertWorkspace'>
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
    if (!result.replayed && decision === 'reject' && this.agentRuntime.decideCommand) {
      await this.agentRuntime.decideCommand({ runId: run.id, commandId: command.id, approved: false });
    }
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

  /** Claims and executes one policy-authorized command; this method is only wired to the run event loop. */
  public async executeAutomatically(input: { readonly ownerId: string; readonly runId: string; readonly commandId: string }): Promise<SandboxCommand> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    const command = await this.commandRepository.findByIdForOwner(input.ownerId, input.runId, input.commandId);
    if (!run || !command || run.projectId !== command.projectId) throw new SandboxCommandNotFoundError();
    if (run.decision !== 'policy_authorized' || !run.policyRevision || run.status !== 'running') return command;
    if (command.status === 'blocked' || command.status === 'cancelled' || command.status === 'cancel_requested') return command;
    if (command.classification !== 'safe' || command.decision !== 'pending' || command.status !== 'awaiting_approval') return command;
    if (!await this.policyCommandReady(run)) return this.blockAwaiting(command, 'The current runtime cannot enforce the bounded command policy. The command was not run.');

    const fingerprint = hashText(JSON.stringify({ version: 'bounded-read-v1', ownerId: run.ownerId, projectId: run.projectId, runId: run.id, commandId: command.id, proposalHash: command.proposalHash, policyRevision: run.policyRevision }));
    const claim = await this.commandRepository.claimPolicyAuthorizedExecution({
      ownerId: run.ownerId, runId: run.id, commandId: command.id, proposalHash: command.proposalHash,
      idempotencyKey: `policy-command-${command.id}`,
      requestFingerprint: fingerprint
    });
    if (claim.replayed || claim.resource.decision !== 'policy_authorized' || claim.resource.status !== 'running') return claim.resource;
    let resultPersisted = false;
    try {
      const beforeCapabilityCheck = await this.assertPolicyRun(run);
      if (!await this.policyCommandRuntimeReady(beforeCapabilityCheck)) {
        return await this.reviewExecution(claim.resource, 'The command authorization changed before dispatch. No command result was shared.');
      }
      const beforeDispatch = await this.assertPolicyRun(beforeCapabilityCheck);
      if (!await this.commandRepository.isPolicyAuthorizedExecution(beforeDispatch.ownerId, beforeDispatch.id, command.id)) {
        return (await this.commandRepository.findByIdForOwner(run.ownerId, run.id, command.id)) ?? claim.resource;
      }
      if (!this.agentRuntime.executePolicyCommand) return this.reviewExecution(claim.resource, 'The private command runtime is unavailable. No command was run.');
      const result = await this.agentRuntime.executePolicyCommand({ runId: beforeDispatch.id, commandId: command.id, command: command.command, args: command.args, cwd: command.cwd, limits: command.limits });
      await this.assertPolicyRun(beforeDispatch);
      if (!await this.commandRepository.isPolicyAuthorizedExecution(run.ownerId, run.id, command.id)) return (await this.commandRepository.findByIdForOwner(run.ownerId, run.id, command.id)) ?? claim.resource;
      const saved = await this.commandRepository.saveExecutionResult(resultUpdate(run.ownerId, run.id, command.id, sanitizeCommandResult(result, command.limits)));
      if (!saved) return (await this.commandRepository.findByIdForOwner(run.ownerId, run.id, command.id)) ?? claim.resource;
      resultPersisted = true;
      await this.assertPolicyRun(beforeDispatch);
      if (!await this.commandRepository.isPolicyAuthorizedExecution(run.ownerId, run.id, command.id)) throw new AssistantExecutionUnavailableError();
      await this.agentRuntime.completePolicyCommand?.({ runId: run.id, commandId: command.id });
      return saved;
    } catch (error: unknown) {
      // A saved process result does not prove that model continuation was acknowledged.
      if (resultPersisted) throw new AssistantExecutionUnavailableError();
      const message = error instanceof AssistantExecutionPolicyChangedError || error instanceof AssistantExecutionUnavailableError
        ? 'Workspace policy or runtime readiness changed. The command result was not shared.'
        : 'The private command result could not be confirmed. Refresh command status before retrying.';
      return this.reviewExecution(claim.resource, message);
    }
  }

  public isPolicyAuthorizedExecution(ownerId: string, runId: string, commandId: string): Promise<boolean> {
    return this.commandRepository.isPolicyAuthorizedExecution(ownerId, runId, commandId);
  }

  private async policyCommandReady(run: AiRun): Promise<boolean> {
    try {
      const current = await this.assertPolicyRun(run);
      return await this.policyCommandRuntimeReady(current);
    } catch {
      return false;
    }
  }

  private async policyCommandRuntimeReady(run: AiRun): Promise<boolean> {
    return Boolean((run.runtimeKind !== 'hermes' || this.agentRuntime.completePolicyCommand) && this.agentRuntime.executePolicyCommand && this.agentRuntime.supportsPolicyCommandExecution
      && await this.agentRuntime.supportsPolicyCommandExecution({ providerProfile: run.manifest.providerProfile, model: run.manifest.model }));
  }

  private async assertPolicyRun(expectedRun: AiRun): Promise<AiRun> {
    if (!this.executionPolicy) throw new AssistantExecutionUnavailableError();
    const run = await this.aiRunRepository.findByIdForOwner(expectedRun.ownerId, expectedRun.id);
    if (!run || run.projectId !== expectedRun.projectId || run.decision !== 'policy_authorized' || !run.policyRevision || run.status !== 'running') {
      throw new AssistantExecutionUnavailableError();
    }
    if (run.policyRevision !== expectedRun.policyRevision || run.manifest.providerProfile !== expectedRun.manifest.providerProfile || run.manifest.model !== expectedRun.manifest.model) {
      throw new AssistantExecutionPolicyChangedError();
    }
    await assertActiveProject(this.projectRepository, run.ownerId, run.projectId);
    const authorization = await this.executionPolicy.assertWorkspace({ ownerId: run.ownerId, projectId: run.projectId, providerProfile: run.manifest.providerProfile, model: run.manifest.model, policyRevision: run.policyRevision });
    if (!authorization.effectiveCapabilities.includes('bounded_sandbox_command')) throw new AssistantExecutionUnavailableError();
    return run;
  }

  private async blockAwaiting(command: SandboxCommand, message: string): Promise<SandboxCommand> {
    return (await this.commandRepository.saveIfAwaiting({ ownerId: command.ownerId, runId: command.runId, commandId: command.id, status: 'blocked', safeMessage: message }))
      ?? (await this.commandRepository.findByIdForOwner(command.ownerId, command.runId, command.id)) ?? command;
  }

  private async reviewExecution(command: SandboxCommand, message: string): Promise<SandboxCommand> {
    return (await this.commandRepository.saveExecutionResult({ ownerId: command.ownerId, runId: command.runId, commandId: command.id, status: 'review_required', safeMessage: message }))
      ?? (await this.commandRepository.findByIdForOwner(command.ownerId, command.runId, command.id)) ?? command;
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
        return this.persistExecutionFailure(command, runId, 'review_required', 'The private sandbox result could not be confirmed. Refresh command status before retrying.');
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
      if (run.runtimeKind === 'hermes' && this.aiRunRepository.requestCancellation) {
        await this.aiRunRepository.requestCancellation({ ownerId: input.ownerId, runId: input.runId, idempotencyKey: `command-cancel-${input.commandId}`, requestFingerprint: hashText(JSON.stringify({ action: 'cancel', commandId: input.commandId })) });
      }
      await this.agentRuntime.cancelCommand({ runId: input.runId, commandId: input.commandId });
    } catch (error: unknown) {
      if (error instanceof AiRunRuntimeUnavailableError) {
        await this.persistCancellationReview(input.ownerId, input.runId, input.commandId);
        throw new SandboxCommandReviewRequiredError();
      }
      await this.persistCancellationReview(input.ownerId, input.runId, input.commandId);
      throw new SandboxCommandReviewRequiredError();
    }
    if (run.runtimeKind === 'hermes') return this.commandRepository.saveResult({ ownerId: input.ownerId, runId: input.runId, commandId: input.commandId, status: 'cancelled', safeMessage: 'Hermes run and command cancelled. No generated changes were applied.' });
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
    argumentSummaries: command.args.map(command.command === 'hermes-terminal' ? summarizeHermesCommand : summarizeArgument),
    cwd: command.cwd,
    classification: command.classification,
    decision: command.decision,
    status: command.status,
    runtimeKind: command.command === 'hermes-terminal' ? 'hermes' : 'fake',
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
  requireProjectFileRoot(project);
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
