import type {
  CommandCancellationUpdate,
  CommandDecisionUpdate,
  CommandResultUpdate,
  CreateSandboxCommandRecord,
  PolicyCommandExecutionClaim,
  SandboxCommand
} from '@/modules/ai-runs/domain/command-types';

export interface CommandMutationResult {
  readonly resource: SandboxCommand;
  readonly replayed: boolean;
}

export interface ISandboxCommandRepository {
  createProposal(input: CreateSandboxCommandRecord): Promise<CommandMutationResult>;
  listForRun(ownerId: string, runId: string, limit?: number): Promise<readonly SandboxCommand[]>;
  findByIdForOwner(ownerId: string, runId: string, commandId: string): Promise<SandboxCommand | null>;
  recordDecision(input: CommandDecisionUpdate): Promise<CommandMutationResult>;
  claimPolicyAuthorizedExecution(input: PolicyCommandExecutionClaim): Promise<CommandMutationResult>;
  isPolicyAuthorizedExecution(ownerId: string, runId: string, commandId: string): Promise<boolean>;
  markRunning(ownerId: string, runId: string, commandId: string): Promise<SandboxCommand | null>;
  recordCancellation(input: CommandCancellationUpdate): Promise<CommandMutationResult>;
  saveIfAwaiting(input: CommandResultUpdate): Promise<SandboxCommand | null>;
  saveResult(input: CommandResultUpdate): Promise<SandboxCommand>;
  saveExecutionResult(input: CommandResultUpdate): Promise<SandboxCommand | null>;
}
