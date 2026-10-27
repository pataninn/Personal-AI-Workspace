import { randomUUID } from 'node:crypto';

import {
  SandboxCommandBlockedError,
  SandboxCommandDecisionConflictError,
  SandboxCommandNotFoundError,
  SandboxCommandProposalConflictError
} from '@/modules/ai-runs/domain/command-errors';
import { AiRunIdempotencyReusedError } from '@/modules/ai-runs/domain/ai-run-errors';
import type {
  CommandCancellationUpdate,
  CommandDecisionUpdate,
  CommandResultUpdate,
  CreateSandboxCommandRecord,
  PolicyCommandExecutionClaim,
  SandboxCommand
} from '@/modules/ai-runs/domain/command-types';
import { MAX_SANDBOX_COMMANDS_PER_LIST } from '@/modules/ai-runs/domain/command-types';
import { sanitizeCommandResult } from '@/modules/ai-runs/domain/command-result';
import type { CommandMutationResult, ISandboxCommandRepository } from '@/modules/ai-runs/repositories/sandbox-command-repository';

interface StoredKey {
  readonly fingerprint: string;
  readonly commandId: string;
}

export class InMemorySandboxCommandRepository implements ISandboxCommandRepository {
  private readonly commands = new Map<string, SandboxCommand>();
  private readonly createKeys = new Map<string, StoredKey>();
  private readonly locks = new Map<string, Promise<void>>();

  public async createProposal(input: CreateSandboxCommandRecord): Promise<CommandMutationResult> {
    return this.withLock(`create:${input.ownerId}:${input.runId}:${input.createIdempotencyKey}`, async () => {
      const key = this.createKey(input);
      const previous = this.createKeys.get(key);
      if (previous) {
        if (previous.fingerprint !== input.createFingerprint) {
          throw new AiRunIdempotencyReusedError();
        }
        const replay = this.commands.get(previous.commandId);
        if (!replay) {
          throw new SandboxCommandNotFoundError();
        }
        return { resource: replay, replayed: true };
      }
      const now = new Date();
      const blocked = input.classification === 'blocked';
      const command: SandboxCommand = {
        id: randomUUID(),
        ownerId: input.ownerId,
        projectId: input.projectId,
        runId: input.runId,
        proposalHash: input.proposalHash,
        command: input.command,
        args: [...input.args],
        cwd: input.cwd,
        summary: input.summary,
        classification: input.classification,
        ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
        decision: blocked ? 'not_applicable' : 'pending',
        status: blocked ? 'blocked' : 'awaiting_approval',
        limits: input.limits,
        cancelRequested: false,
        createIdempotencyKey: input.createIdempotencyKey,
        createFingerprint: input.createFingerprint,
        safeMessage: blocked ? 'The sandbox policy blocked this command before approval.' : 'Review this command before it runs.',
        createdAt: now,
        updatedAt: now
      };
      this.commands.set(command.id, command);
      this.createKeys.set(key, { fingerprint: input.createFingerprint, commandId: command.id });
      return { resource: command, replayed: false };
    });
  }

  public async listForRun(ownerId: string, runId: string, limit = MAX_SANDBOX_COMMANDS_PER_LIST): Promise<readonly SandboxCommand[]> {
    return [...this.commands.values()]
      .filter((command) => command.ownerId === ownerId && command.runId === runId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, Math.max(0, Math.min(Math.floor(limit), MAX_SANDBOX_COMMANDS_PER_LIST)));
  }

  public async findByIdForOwner(ownerId: string, runId: string, commandId: string): Promise<SandboxCommand | null> {
    const command = this.commands.get(commandId);
    return command?.ownerId === ownerId && command.runId === runId ? command : null;
  }

  public async recordDecision(input: CommandDecisionUpdate): Promise<CommandMutationResult> {
    return this.withLock(this.stateLockKey(input.commandId), async () => {
      const command = this.requireCommand(input.ownerId, input.runId, input.commandId);
      if (command.proposalHash !== input.proposalHash) {
        throw new SandboxCommandProposalConflictError();
      }
      if (command.status === 'blocked') {
        throw new SandboxCommandBlockedError();
      }
      if (command.decisionIdempotencyKey) {
        if (command.decisionIdempotencyKey !== input.idempotencyKey || command.decisionFingerprint !== input.requestFingerprint) {
          throw new SandboxCommandDecisionConflictError();
        }
        return { resource: command, replayed: true };
      }
      if (command.decision !== 'pending') {
        throw new SandboxCommandDecisionConflictError();
      }
      const rejected = input.decision === 'reject';
      const updated: SandboxCommand = {
        ...command,
        decision: rejected ? 'rejected' : 'approved',
        status: rejected ? 'rejected' : 'awaiting_approval',
        decisionIdempotencyKey: input.idempotencyKey,
        decisionFingerprint: input.requestFingerprint,
        safeMessage: rejected ? 'This command was rejected and was not started.' : 'Approval recorded. Starting the private sandbox command.',
        updatedAt: new Date()
      };
      this.commands.set(updated.id, updated);
      return { resource: updated, replayed: false };
    });
  }

  public async claimPolicyAuthorizedExecution(input: PolicyCommandExecutionClaim): Promise<CommandMutationResult> {
    return this.withLock(this.stateLockKey(input.commandId), async () => {
      const command = this.requireCommand(input.ownerId, input.runId, input.commandId);
      if (command.proposalHash !== input.proposalHash) throw new SandboxCommandProposalConflictError();
      if (command.decisionIdempotencyKey) {
        if (command.decisionIdempotencyKey !== input.idempotencyKey || command.decisionFingerprint !== input.requestFingerprint) throw new SandboxCommandDecisionConflictError();
        return { resource: command, replayed: true };
      }
      if (command.classification !== 'safe' || command.decision !== 'pending' || command.status !== 'awaiting_approval' || command.cancelRequested) {
        throw new SandboxCommandDecisionConflictError();
      }
      const updated: SandboxCommand = {
        ...command,
        decision: 'policy_authorized',
        status: 'running',
        decisionIdempotencyKey: input.idempotencyKey,
        decisionFingerprint: input.requestFingerprint,
        safeMessage: 'The stored workspace policy authorized this bounded command.',
        updatedAt: new Date()
      };
      this.commands.set(updated.id, updated);
      return { resource: updated, replayed: false };
    });
  }

  public async isPolicyAuthorizedExecution(ownerId: string, runId: string, commandId: string): Promise<boolean> {
    const command = await this.findByIdForOwner(ownerId, runId, commandId);
    return Boolean(command && command.decision === 'policy_authorized' && !command.cancelRequested && ['running', 'completed', 'failed', 'timed_out', 'output_truncated'].includes(command.status));
  }

  public async recordCancellation(input: CommandCancellationUpdate): Promise<CommandMutationResult> {
    return this.withLock(this.stateLockKey(input.commandId), async () => {
      const command = this.requireCommand(input.ownerId, input.runId, input.commandId);
      if (command.cancelIdempotencyKey) {
        if (command.cancelIdempotencyKey !== input.idempotencyKey || command.cancelFingerprint !== input.requestFingerprint) {
          throw new SandboxCommandDecisionConflictError();
        }
        return { resource: command, replayed: true };
      }
      if (isTerminal(command.status)) {
        return { resource: command, replayed: true };
      }
      const running = command.status === 'running' || command.status === 'cancel_requested';
      const updated: SandboxCommand = {
        ...command,
        status: running ? 'cancel_requested' : 'cancelled',
        decision: command.decision === 'pending' ? 'rejected' : command.decision,
        cancelRequested: true,
        cancelIdempotencyKey: input.idempotencyKey,
        cancelFingerprint: input.requestFingerprint,
        safeMessage: running ? 'Cancellation requested for the private sandbox command.' : 'This command was cancelled before it started.',
        updatedAt: new Date()
      };
      this.commands.set(updated.id, updated);
      return { resource: updated, replayed: false };
    });
  }

  public async markRunning(ownerId: string, runId: string, commandId: string): Promise<SandboxCommand | null> {
    return this.withLock(this.stateLockKey(commandId), async () => {
      const command = this.requireCommand(ownerId, runId, commandId);
      if (command.status !== 'awaiting_approval' || command.decision !== 'approved' || command.cancelRequested) {
        return command;
      }
      const updated: SandboxCommand = { ...command, status: 'running', safeMessage: 'Running the command in the private sandbox.', updatedAt: new Date() };
      this.commands.set(updated.id, updated);
      return updated;
    });
  }

  public async saveResult(input: CommandResultUpdate): Promise<SandboxCommand> {
    return this.withLock(this.stateLockKey(input.commandId), async () => {
      const command = this.requireCommand(input.ownerId, input.runId, input.commandId);
      if (command.status !== 'cancel_requested') {
        return command;
      }
      const updated: SandboxCommand = {
        ...command,
        status: input.status,
        ...(input.result ? { result: sanitizeCommandResult(input.result, command.limits) } : {}),
        ...(input.cancelRequested === undefined ? {} : { cancelRequested: input.cancelRequested }),
        safeMessage: input.safeMessage,
        updatedAt: new Date()
      };
      this.commands.set(updated.id, updated);
      return updated;
    });
  }

  public async saveIfAwaiting(input: CommandResultUpdate): Promise<SandboxCommand | null> {
    return this.withLock(this.stateLockKey(input.commandId), async () => {
      const command = this.commands.get(input.commandId);
      if (!command || command.ownerId !== input.ownerId || command.runId !== input.runId || command.status !== 'awaiting_approval' || command.cancelRequested) {
        return null;
      }
      const updated: SandboxCommand = { ...command, status: input.status, ...(input.result ? { result: sanitizeCommandResult(input.result, command.limits) } : {}), safeMessage: input.safeMessage, updatedAt: new Date() };
      this.commands.set(updated.id, updated);
      return updated;
    });
  }

  public async saveExecutionResult(input: CommandResultUpdate): Promise<SandboxCommand | null> {
    return this.withLock(this.stateLockKey(input.commandId), async () => {
      const command = this.commands.get(input.commandId);
      if (!command || command.ownerId !== input.ownerId || command.runId !== input.runId || command.status !== 'running' || command.cancelRequested) {
        return null;
      }
      const updated: SandboxCommand = {
        ...command,
        status: input.status,
        ...(input.result ? { result: sanitizeCommandResult(input.result, command.limits) } : {}),
        safeMessage: input.safeMessage,
        updatedAt: new Date()
      };
      this.commands.set(updated.id, updated);
      return updated;
    });
  }

  private requireCommand(ownerId: string, runId: string, commandId: string): SandboxCommand {
    const command = this.commands.get(commandId);
    if (!command || command.ownerId !== ownerId || command.runId !== runId) {
      throw new SandboxCommandNotFoundError();
    }
    return command;
  }

  private createKey(input: CreateSandboxCommandRecord): string {
    return `${input.ownerId}:${input.runId}:${input.createIdempotencyKey}`;
  }

  private stateLockKey(commandId: string): string {
    return `state:${commandId}`;
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }
}

function isTerminal(status: SandboxCommand['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'timed_out' || status === 'output_truncated' || status === 'rejected' || status === 'blocked' || status === 'cancelled' || status === 'review_required';
}
