import { createHash, randomUUID } from 'node:crypto';

import { AiRunNotFoundError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { AiRun } from '@/modules/ai-runs/domain/ai-run-types';
import {
  ChangeSetAlreadyDecidedError,
  ChangeSetBlockedError,
  ChangeSetConflictError,
  ChangeSetNotFoundError,
  ChangeSetReviewRequiredError,
  ChangeSetValidationError
} from '@/modules/ai-runs/domain/change-errors';
import { CHANGE_SET_LIMITS, isDestructiveOperation } from '@/modules/ai-runs/domain/change-policy';
import { validateHtmlDocumentChange } from '@/modules/ai-runs/domain/html-document-validation';
import type {
  ChangeOperationResult,
  ChangeSetDecisionResult,
  CreateProposedChangeSetRecord,
  PolicyAuthorizedChangeSetApplyClaim,
  ProposedChangeOperation,
  ProposedChangeSet,
  RuntimeChangeProposal
} from '@/modules/ai-runs/domain/change-types';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IProposedChangeSetRepository } from '@/modules/ai-runs/repositories/change-set-repository';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import { requireProjectFileRoot, requireProjectFileScope } from '@/modules/projects/domain/project-file-root';
import type { IWorkspaceMutationGateway, WorkspaceFileSnapshot, WorkspaceMutationScope, WorkspaceApplyResult } from '@/modules/ai-runs/repositories/workspace-mutation-gateway';
import type { IProjectChatContextRepository } from '@/modules/ai-runs/repositories/project-chat-context-repository';
import { assertActiveAiRunProject, assertAiRunProjectHasFileRoot } from '@/modules/ai-runs/use-cases/assert-ai-run-project';
import { hashText } from '@/modules/ai-runs/use-cases/manifest-builder';
import { redactSensitiveText, truncateUtf8 } from '@/infrastructure/workspace/workspace-text';
import { WorkspaceRelativePath } from '@/modules/files/domain/workspace-path';
import { isProtectedFileName } from '@/modules/files/domain/workspace-policy';
import { containsCredentialLikeValue } from '@/shared/egress/redaction';
import type { IPrincipalAuthorization } from '@/modules/auth/use-cases/principal-authorization';
import { StorageQuotaError } from '@/modules/storage-quotas/domain/storage-quota-errors';
import type { AssertAssistantExecutionPolicyUseCase } from '@/modules/assistant-policy/use-cases/assert-assistant-execution-policy';
import { AssistantExecutionPolicyChangedError, AssistantExecutionUnavailableError } from '@/modules/assistant-policy/domain/assistant-execution-errors';
import { PolicyActionRetiredError } from '@/modules/assistant-policy/domain/policy-action-retired-error';

export interface CollectChangeSetInput {
  readonly ownerId: string;
  readonly runId: string;
  readonly changes: readonly RuntimeChangeProposal[];
  readonly fakeRuntime: boolean;
}

export interface ChangeSetDecisionInput {
  readonly ownerId: string;
  readonly runId: string;
  readonly proposalHash: string;
  readonly decision: 'approve' | 'reject';
  readonly idempotencyKey: string;
}

export class CollectProposedChangeSetUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly projectRepository: IProjectRepository,
    private readonly workspace: IWorkspaceMutationGateway,
    private readonly changeSets: IProposedChangeSetRepository
  ) {}

  public async execute(input: CollectChangeSetInput): Promise<ProposedChangeSet> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new AiRunNotFoundError();
    }
    const project = await this.projectRepository.findByIdForOwner(input.ownerId, run.projectId);
    if (!project || project.status === 'archived') {
      throw new ChangeSetBlockedError('The project is archived or unavailable for proposed changes.');
    }
    if (input.changes.length === 0 || input.changes.length > CHANGE_SET_LIMITS.maxOperations) {
      throw new ChangeSetValidationError([{ field: 'changes', message: 'The proposed operation count is outside the safe limit.' }]);
    }
    const scope: WorkspaceMutationScope = requireProjectFileScope(project);
    const operations = await this.buildOperations(scope, run.manifest.files, input.changes);
    const totalSizeBytes = operations.reduce((total, operation) => total + operation.sizeBytes, 0);
    if (totalSizeBytes > CHANGE_SET_LIMITS.maxTotalContentBytes) {
      throw new ChangeSetValidationError([{ field: 'changes', message: 'The proposed change set is too large.' }]);
    }
    const proposalHash = canonicalProposalHash(operations);
    const record: CreateProposedChangeSetRecord = {
      runId: run.id,
      ownerId: run.ownerId,
      projectId: run.projectId,
      proposalHash,
      operations,
      counts: countOperations(operations),
      totalSizeBytes,
      totalLineCount: operations.reduce((total, operation) => total + operation.lineCount, 0),
      previewLimitBytes: CHANGE_SET_LIMITS.maxPreviewBytes,
      previewLimitLines: CHANGE_SET_LIMITS.maxPreviewLines,
      fakeRuntime: input.fakeRuntime
    };
    return this.changeSets.create(record);
  }

  private async buildOperations(
    scope: WorkspaceMutationScope,
    manifestFiles: readonly { readonly relativePath: string; readonly sourceHash: string }[],
    changes: readonly RuntimeChangeProposal[]
  ): Promise<readonly ProposedChangeOperation[]> {
    const seen = new Set<string>();
    const operations: ProposedChangeOperation[] = [];
    let previewBytes = 0;
    for (const [index, change] of changes.entries()) {
      validateUntrustedText(change, index);
      const operation = await this.buildOperation(scope, manifestFiles, change, index, seen);
      if (!operation.reviewable) {
        throw new ChangeSetBlockedError('A safe bounded preview is unavailable for this proposed operation.');
      }
      previewBytes += Buffer.byteLength(operation.preview?.text ?? '', 'utf8');
      if (previewBytes > CHANGE_SET_LIMITS.maxTotalPreviewBytes) {
        throw new ChangeSetValidationError([{ field: 'changes', message: 'The bounded change preview is too large.' }]);
      }
      operations.push(operation);
    }
    return operations;
  }

  private async buildOperation(
    scope: WorkspaceMutationScope,
    manifestFiles: readonly { readonly relativePath: string; readonly sourceHash: string }[],
    change: RuntimeChangeProposal,
    index: number,
    seen: Set<string>
  ): Promise<ProposedChangeOperation> {
    const operation = parseOperation(change, index);
    const path = parsePath(change.path, 'path');
    const destinationPath = change.destinationPath === undefined ? undefined : parsePath(change.destinationPath, 'destinationPath');
    const key = `${operation}:${path}:${destinationPath ?? ''}`;
    if (seen.has(key)) {
      throw new ChangeSetValidationError([{ field: `changes.${index}`, message: 'The proposed operation is duplicated.' }]);
    }
    seen.add(key);
    const source = await this.workspace.inspect(scope, path);
    const destination = destinationPath ? await this.workspace.inspect(scope, destinationPath) : source;
    const sourceHash = manifestFiles.find((file) => file.relativePath === path)?.sourceHash ?? source.hash;
    validateOperation(operation, path, destinationPath, change.content, source, destination, index);
    const expectedSourceHash = requiresSource(operation) ? change.expectedSourceHash ?? sourceHash : undefined;
    const expectedDestinationHash = operation === 'rename' && destination.exists ? change.expectedDestinationHash ?? destination.hash : undefined;
    if (requiresSource(operation) && !expectedSourceHash) {
      throw new ChangeSetBlockedError('The proposed source has no exact current hash.');
    }
    if (expectedSourceHash && source.hash !== expectedSourceHash) {
      throw new ChangeSetConflictError('The project changed before the proposed change set was collected.');
    }
    validateHtmlDocumentChange({ path, sourceContent: source.content, content: change.content });
    const content = change.content;
    const preview = createPreview(operation, source, destination, content ?? '');
    const sizeBytes = content !== undefined ? Buffer.byteLength(content, 'utf8') : source.sizeBytes;
    return {
      operationId: randomUUID(),
      operation,
      path,
      ...(destinationPath ? { destinationPath } : {}),
      ...(content === undefined ? {} : { content }),
      summary: safeSummary(change.summary, operation, path),
      ...(expectedSourceHash ? { expectedSourceHash } : {}),
      ...(expectedDestinationHash ? { expectedDestinationHash } : {}),
      sourcePresent: source.exists,
      destinationPresent: operation === 'rename' ? destination.exists : source.exists,
      backupRequired: isDestructiveOperation(operation, destination.exists),
      ...(preview ? { preview } : {}),
      sizeBytes,
      lineCount: countLines(content ?? source.content ?? ''),
      reviewable: preview !== undefined
    };
  }
}

function validateUntrustedText(change: RuntimeChangeProposal, index: number): void {
  if (containsCredentialLikeValue(change.content ?? '')) {
    throw new ChangeSetValidationError([{ field: `changes.${index}.content`, message: 'The proposed content contains a credential-like value.' }]);
  }
  if (containsCredentialLikeValue(change.summary ?? '')) {
    throw new ChangeSetValidationError([{ field: `changes.${index}.summary`, message: 'The proposed summary contains a credential-like value.' }]);
  }
}

export class GetProposedChangeSetUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly projectRepository: IProjectRepository,
    private readonly changeSets: IProposedChangeSetRepository
  ) {}

  public async execute(input: { readonly ownerId: string; readonly runId: string }): Promise<ProposedChangeSet> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new ChangeSetNotFoundError();
    }
    await assertAiRunProjectHasFileRoot(this.projectRepository, input.ownerId, run.projectId);
    const changeSet = await this.changeSets.findByRunForOwner(input.ownerId, input.runId);
    if (!changeSet) {
      throw new ChangeSetNotFoundError();
    }
    return changeSet;
  }
}

export class DecideProposedChangeSetUseCase {
  public constructor(
    private readonly aiRunRepository: IAiRunRepository,
    private readonly projectRepository: IProjectRepository,
    private readonly changeSets: IProposedChangeSetRepository,
    private readonly workspace: IWorkspaceMutationGateway,
    private readonly contexts?: IProjectChatContextRepository,
    private readonly principalAuthorization?: IPrincipalAuthorization,
    private readonly executionPolicy?: Pick<AssertAssistantExecutionPolicyUseCase, 'assertWorkspace'>
  ) {}

  public async execute(input: ChangeSetDecisionInput): Promise<ProposedChangeSet> {
    return this.executeDecision(input);
  }

  /** Applies the current persisted workspace policy without recording a user decision. */
  public async executeAutomatically(input: { readonly ownerId: string; readonly runId: string }): Promise<ProposedChangeSet | null> {
    await this.principalAuthorization?.assertActive(input.ownerId);
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) throw new AiRunNotFoundError();
    if (run.decision !== 'policy_authorized' || !run.policyRevision) throw new PolicyActionRetiredError();
    if (run.status !== 'running') throw new ChangeSetBlockedError('Workspace changes cannot be applied after the run stops.');
    await assertActiveAiRunProject(this.aiRunRepository, this.projectRepository, input.ownerId, input.runId);
    const changeSet = await this.changeSets.findByRunForOwner(input.ownerId, input.runId);
    if (!changeSet) return null;
    const authorization = await this.assertCurrentWorkspacePolicy(run);
    if (!authorization.effectiveCapabilities.includes('workspace_file_write')) {
      throw new ChangeSetBlockedError('The current workspace policy does not allow file changes.');
    }
    const claim: PolicyAuthorizedChangeSetApplyClaim = {
      ownerId: input.ownerId,
      projectId: run.projectId,
      runId: run.id,
      proposalHash: changeSet.proposalHash,
      policyRevision: run.policyRevision,
      providerProfile: run.manifest.providerProfile,
      model: run.manifest.model,
      idempotencyKey: `policy-apply-${changeSet.id}`,
      requestFingerprint: hashText(JSON.stringify({
        actor: 'policy_authorized', ownerId: input.ownerId, projectId: run.projectId, runId: run.id,
        proposalHash: changeSet.proposalHash, policyRevision: run.policyRevision
      }))
    };
    const claimed = await this.changeSets.claimPolicyAuthorizedApply(claim);
    if (claimed.replayed) {
      if (claimed.resource.status === 'applying') return this.saveManualReview(claimed.resource);
      return claimed.resource;
    }
    const applied = await this.applyChangeSet(claimed, run);
    await this.refreshSelectedPaths(applied);
    return applied;
  }

  private async refreshSelectedPaths(changeSet: ProposedChangeSet): Promise<void> {
    if (!this.contexts || changeSet.status !== 'applied') return;
    const context = await this.contexts.get(changeSet.ownerId, changeSet.projectId);
    let relativePaths = [...context.relativePaths];
    for (const operation of changeSet.result?.operations ?? []) {
      if (operation.status !== 'applied') continue;
      if (operation.operation === 'delete') relativePaths = relativePaths.filter((path) => path !== operation.path);
      if (operation.operation === 'rename' && operation.destinationPath) relativePaths = relativePaths.map((path) => path === operation.path ? operation.destinationPath ?? path : path);
    }
    if (JSON.stringify(relativePaths) !== JSON.stringify(context.relativePaths)) await this.contexts.update(changeSet.ownerId, changeSet.projectId, { relativePaths: [...new Set(relativePaths)] });
  }

  private async executeDecision(input: ChangeSetDecisionInput): Promise<ProposedChangeSet> {
    await this.principalAuthorization?.assertActive(input.ownerId);
    return this.executeDecisionWhileActive(input);
  }

  private async executeDecisionWhileActive(input: ChangeSetDecisionInput): Promise<ProposedChangeSet> {
    const run = await this.aiRunRepository.findByIdForOwner(input.ownerId, input.runId);
    if (!run) {
      throw new AiRunNotFoundError();
    }
    await assertActiveAiRunProject(this.aiRunRepository, this.projectRepository, input.ownerId, input.runId);
    if (run.status !== 'succeeded') {
      throw new ChangeSetBlockedError('Proposed changes can be applied only after the run completes successfully.');
    }
    const requestFingerprint = hashText(JSON.stringify({ proposalHash: input.proposalHash, decision: input.decision }));
    const decision = await this.changeSets.recordDecision({ ...input, requestFingerprint });
    if (decision.replayed) {
      return decision.resource;
    }
    if (input.decision === 'reject') {
      const rejected = withoutRawContent(decision.resource);
      await this.changeSets.save(rejected);
      return rejected;
    }
    return this.applyChangeSet(decision);
  }

  private async applyChangeSet(decision: ChangeSetDecisionResult, policyAuthorizedRun?: AiRun): Promise<ProposedChangeSet> {
    let changeSet = decision.resource;
    const policyAuthorized = changeSet.decision === 'policy_authorized';
    const scope = await this.projectFileScope(changeSet.ownerId, changeSet.projectId);
    let applied: WorkspaceApplyResult;
    try {
      applied = await this.workspace.applyChangeSet(scope, changeSet.operations, changeSet.runId, changeSet.proposalHash, {
        ...(this.principalAuthorization || policyAuthorizedRun ? { assertPrincipalActive: async () => {
          await this.principalAuthorization?.assertActive(changeSet.ownerId);
          if (policyAuthorizedRun) {
            const authorization = await this.assertCurrentWorkspacePolicy(policyAuthorizedRun);
            if (!authorization.effectiveCapabilities.includes('workspace_file_write')) throw new AssistantExecutionPolicyChangedError();
          }
        } } : {}),
        recordBackupCheckpoint: async (checkpoint) => {
          const checkpoints = [...(changeSet.backupCheckpoints ?? []), checkpoint];
          const checkpointed: ProposedChangeSet = { ...changeSet, backupCheckpoints: checkpoints, updatedAt: new Date() };
          await this.changeSets.save(checkpointed);
          changeSet = checkpointed;
        }
      });
    } catch (error: unknown) {
      if (error instanceof StorageQuotaError && (error.code === 'STORAGE_QUOTA_EXCEEDED' || error.code === 'STORAGE_ACCOUNTING_UNAVAILABLE')) {
        const failed = withResult(withStatus(changeSet, 'failed', policyAuthorized
          ? 'The workspace-policy authorized changes were not applied because storage could not admit them.'
          : 'The approved changes were not applied because storage could not admit them.'), {
          persisted: true,
          operations: changeSet.operations.map((operation) => ({
            operationId: operation.operationId,
            operation: operation.operation,
            path: operation.path,
            ...(operation.destinationPath ? { destinationPath: operation.destinationPath } : {}),
            status: 'failed' as const,
            backup: operation.backupRequired ? 'not_created' as const : 'not_required' as const,
            safeMessage: 'The file change was not applied because storage quota or accounting readiness prevented it.'
          })),
          appliedCount: 0,
          skippedCount: 0,
          failedCount: changeSet.operations.length,
          backupCount: 0
        });
        await this.changeSets.save(failed);
        throw error;
      }
      return this.saveManualReview(changeSet);
    }
    if (applied.outcome === 'stale') {
      const result = toChangeSetResult(applied);
      const safeMessage = result.appliedCount > 0
        ? `The project changed at ${applied.conflict?.path ?? 'a file'} after this proposal was prepared. Some earlier operations were applied. Review the operation results and current files before requesting new changes.`
        : `The project changed at ${applied.conflict?.path ?? 'a file'} after this proposal was prepared. No operations from this proposal were applied.`;
      const stale = withResult(withStatus(changeSet, 'stale', safeMessage), { ...result, ...(applied.conflict?.path ? { conflictPath: applied.conflict.path } : {}) });
      await this.changeSets.save(stale);
      throw new ChangeSetConflictError(stale.safeMessage);
    }
    const result = toChangeSetResult(applied);
    const status = applied.outcome === 'needs_manual_review' ? 'needs_manual_review' : applied.outcome === 'failed' ? 'failed' : 'applied';
    const message = status === 'applied'
      ? policyAuthorized ? 'The workspace policy allowed these file changes. The result was saved.' : 'The approved change set was applied and its result was saved.'
      : status === 'failed'
        ? 'The change set did not complete. Inspect the listed results before retrying.'
        : 'The app could not confirm whether every file operation finished. Refresh apply status and inspect the project.';
    const terminal = withResult(withStatus(changeSet, status, message), result);
    try {
      await this.changeSets.save(terminal);
    } catch {
      return this.saveManualReview(changeSet);
    }
    if (status === 'needs_manual_review') {
      throw new ChangeSetReviewRequiredError();
    }
    return terminal;
  }

  private async projectFileScope(ownerId: string, projectId: string): Promise<WorkspaceMutationScope> {
    const project = await this.projectRepository.findByIdForOwner(ownerId, projectId);
    if (!project || project.status === 'archived') {
      throw new ChangeSetBlockedError('This project is archived and read-only.');
    }
    return requireProjectFileScope(project);
  }

  private async assertCurrentWorkspacePolicy(run: AiRun) {
    if (!this.executionPolicy || run.decision !== 'policy_authorized' || !run.policyRevision) {
      throw new AssistantExecutionUnavailableError();
    }
    return this.executionPolicy.assertWorkspace({
      ownerId: run.ownerId,
      projectId: run.projectId,
      providerProfile: run.manifest.providerProfile,
      model: run.manifest.model,
      policyRevision: run.policyRevision
    });
  }

  private async saveManualReview(changeSet: ProposedChangeSet): Promise<ProposedChangeSet> {
    const manual = withStatus(changeSet, 'needs_manual_review', 'The app could not confirm whether every file operation or backup finished. Do not retry automatically.');
    try {
      await this.changeSets.save(manual);
    } catch {
      throw new ChangeSetReviewRequiredError();
    }
    throw new ChangeSetReviewRequiredError();
  }
}

function parseOperation(change: RuntimeChangeProposal, index: number): RuntimeChangeProposal['operation'] {
  if (!['create', 'edit', 'overwrite', 'rename', 'delete'].includes(change.operation)) {
    throw new ChangeSetValidationError([{ field: `changes.${index}.operation`, message: 'The operation is not supported.' }]);
  }
  return change.operation;
}

function parsePath(value: string, field: string): string {
  try {
    return WorkspaceRelativePath.parse(value, { field, maxLength: CHANGE_SET_LIMITS.maxPathLength }).value;
  } catch {
    throw new ChangeSetValidationError([{ field, message: 'Use a normalized relative project path.' }]);
  }
}

function validateOperation(operation: RuntimeChangeProposal['operation'], path: string, destinationPath: string | undefined, content: string | undefined, source: WorkspaceFileSnapshot, destination: WorkspaceFileSnapshot, index: number): void {
  if (operation === 'rename' && !destinationPath) {
    throw new ChangeSetValidationError([{ field: `changes.${index}.destinationPath`, message: 'Rename requires a destination path.' }]);
  }
  if (operation !== 'rename' && destinationPath) {
    throw new ChangeSetValidationError([{ field: `changes.${index}.destinationPath`, message: 'Only rename accepts a destination path.' }]);
  }
  if (['create', 'edit', 'overwrite'].includes(operation) && content === undefined) {
    throw new ChangeSetValidationError([{ field: `changes.${index}.content`, message: 'The operation requires bounded UTF-8 file content.' }]);
  }
  if (content !== undefined && Buffer.byteLength(content, 'utf8') > CHANGE_SET_LIMITS.maxContentBytes) {
    throw new ChangeSetValidationError([{ field: `changes.${index}.content`, message: 'The proposed file content is too large.' }]);
  }
  if (isProtectedFileName(path)) {
    throw new ChangeSetBlockedError('Protected project files cannot be changed.');
  }
  if (destinationPath && isProtectedFileName(destinationPath)) {
    throw new ChangeSetBlockedError('Protected project files cannot be changed.');
  }
  if (operation === 'create' && destination.exists) {
    throw new ChangeSetConflictError('The destination already exists.');
  }
  if (requiresSource(operation) && (!source.exists || source.isDirectory)) {
    throw new ChangeSetConflictError('The source file is missing or is not a regular file.');
  }
  if (operation === 'edit' && source.content === undefined) {
    throw new ChangeSetBlockedError('Binary file content cannot be edited as UTF-8 text.');
  }
  if (operation === 'rename' && destination.isDirectory) {
    throw new ChangeSetConflictError('The destination is a directory.');
  }
}

function requiresSource(operation: RuntimeChangeProposal['operation']): boolean {
  return operation !== 'create';
}

function createPreview(operation: RuntimeChangeProposal['operation'], source: WorkspaceFileSnapshot, destination: WorkspaceFileSnapshot, content: string): ProposedChangeOperation['preview'] {
  const before = redactSensitiveText(source.content ?? (source.exists && !source.isDirectory ? `[Binary file: ${source.sizeBytes} bytes]` : ''));
  const after = redactSensitiveText(content);
  if (operation === 'create') {
    return boundPreview(after, 'after');
  }
  if (operation === 'delete') {
    return boundPreview(before, 'before');
  }
  if (operation === 'rename') {
    return boundPreview(before, 'before');
  }
  const diff = makeDiff(before, after);
  return boundPreview(diff.text, 'diff', diff.limited);
}

function boundPreview(value: string, kind: 'before' | 'after' | 'diff', wasLimited = false): ProposedChangeOperation['preview'] {
  const lines = value.split(/\r\n|\r|\n/u);
  const lineLimited = lines.length > CHANGE_SET_LIMITS.maxPreviewLines;
  const lineBounded = lines.slice(0, CHANGE_SET_LIMITS.maxPreviewLines).join('\n');
  const text = truncateUtf8(lineBounded, CHANGE_SET_LIMITS.maxPreviewBytes);
  const limited = wasLimited || lineLimited || text.length !== lineBounded.length;
  return { text, limited, kind };
}

function makeDiff(before: string, after: string): { readonly text: string; readonly limited: boolean } {
  const maxInputLines = 100;
  const maxOutputLines = 200;
  const maxOutputBytes = 8 * 1024;
  const originalBefore = before.split(/\r\n|\r|\n/u);
  const originalAfter = after.split(/\r\n|\r|\n/u);
  const beforeLines = originalBefore.slice(0, maxInputLines);
  const afterLines = originalAfter.slice(0, maxInputLines);
  const lcs: number[][] = Array.from({ length: beforeLines.length + 1 }, () => Array<number>(afterLines.length + 1).fill(0));
  for (let left = beforeLines.length - 1; left >= 0; left--) {
    for (let right = afterLines.length - 1; right >= 0; right--) {
      lcs[left]![right] = beforeLines[left] === afterLines[right]
        ? (lcs[left + 1]?.[right + 1] ?? 0) + 1
        : Math.max(lcs[left + 1]?.[right] ?? 0, lcs[left]?.[right + 1] ?? 0);
    }
  }
  const output: string[] = [];
  let bytes = 0;
  let left = 0;
  let right = 0;
  let limited = originalBefore.length > maxInputLines || originalAfter.length > maxInputLines;
  const append = (line: string): boolean => {
    const lineBytes = Buffer.byteLength(line, 'utf8') + (output.length > 0 ? 1 : 0);
    if (output.length >= maxOutputLines || bytes + lineBytes > maxOutputBytes) {
      limited = true;
      return false;
    }
    output.push(line);
    bytes += lineBytes;
    return true;
  };
  while (left < beforeLines.length || right < afterLines.length) {
    if (left < beforeLines.length && right < afterLines.length && beforeLines[left] === afterLines[right]) {
      if (!append(`  ${beforeLines[left] ?? ''}`)) break;
      left++;
      right++;
    } else if (left < beforeLines.length && (right >= afterLines.length || (lcs[left + 1]?.[right] ?? 0) >= (lcs[left]?.[right + 1] ?? 0))) {
      if (!append(`- ${beforeLines[left] ?? ''}`)) break;
      left++;
    } else {
      if (!append(`+ ${afterLines[right] ?? ''}`)) break;
      right++;
    }
  }
  return { text: output.join('\n'), limited };
}

function safeSummary(value: string | undefined, operation: RuntimeChangeProposal['operation'], relativePath: string): string {
  const fallback = `${operation} ${relativePath}`;
  const candidate = redactSensitiveText(value?.trim() || fallback).replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return truncateUtf8(candidate, CHANGE_SET_LIMITS.maxSummaryLength) || fallback;
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/u).length;
}

function canonicalProposalHash(operations: readonly ProposedChangeOperation[]): string {
  return hashText(JSON.stringify(operations.map((operation) => ({
    operation: operation.operation,
    path: operation.path,
    destinationPath: operation.destinationPath ?? null,
    expectedSourceHash: operation.expectedSourceHash ?? null,
    expectedDestinationHash: operation.expectedDestinationHash ?? null,
    contentHash: operation.content ? createHash('sha256').update(operation.content, 'utf8').digest('hex') : null,
    sizeBytes: operation.sizeBytes,
    lineCount: operation.lineCount,
    backupRequired: operation.backupRequired
  }))));
}

function toChangeSetResult(result: WorkspaceApplyResult): NonNullable<ProposedChangeSet['result']> {
  const operations: readonly ChangeOperationResult[] = result.operations;
  return {
    persisted: true,
    operations,
    appliedCount: operations.filter((operation) => operation.status === 'applied').length,
    skippedCount: operations.filter((operation) => operation.status === 'skipped').length,
    failedCount: operations.filter((operation) => operation.status === 'failed' || operation.status === 'needs_manual_review').length,
    backupCount: operations.filter((operation) => operation.backup === 'created').length,
    ...(result.conflict?.path ? { conflictPath: result.conflict.path } : {})
  };
}

function countOperations(operations: readonly ProposedChangeOperation[]): CreateProposedChangeSetRecord['counts'] {
  return {
    total: operations.length,
    creates: operations.filter((operation) => operation.operation === 'create').length,
    edits: operations.filter((operation) => operation.operation === 'edit').length,
    overwrites: operations.filter((operation) => operation.operation === 'overwrite').length,
    renames: operations.filter((operation) => operation.operation === 'rename').length,
    deletes: operations.filter((operation) => operation.operation === 'delete').length,
    destructive: operations.filter((operation) => operation.backupRequired).length
  };
}

function withStatus(changeSet: ProposedChangeSet, status: ProposedChangeSet['status'], safeMessage: string): ProposedChangeSet {
  const next = { ...changeSet, status, safeMessage, updatedAt: new Date() };
  return isTerminalChangeSetStatus(status) ? withoutRawContent(next) : next;
}

function withResult(changeSet: ProposedChangeSet, result: NonNullable<ProposedChangeSet['result']>): ProposedChangeSet {
  return withoutRawContent({ ...changeSet, result, updatedAt: new Date() });
}

function isTerminalChangeSetStatus(status: ProposedChangeSet['status']): boolean {
  return ['applied', 'rejected', 'stale', 'blocked', 'failed', 'needs_manual_review'].includes(status);
}

function withoutRawContent(changeSet: ProposedChangeSet): ProposedChangeSet {
  const operations = changeSet.operations.map((operation) => {
    const { content: _content, preview, ...safeOperation } = operation;
    return {
      ...safeOperation,
      ...(preview ? { preview: withoutProposedPreviewBytes(preview) } : {})
    };
  });
  return { ...changeSet, operations };
}

function withoutProposedPreviewBytes(preview: NonNullable<ProposedChangeOperation['preview']>): NonNullable<ProposedChangeOperation['preview']> {
  if (preview.kind !== 'diff') {
    return { ...preview, text: 'Preview omitted after the change-set decision.', limited: true };
  }
  const beforeOnly = preview.text.split('\n').filter((line) => !line.startsWith('+ ')).join('\n');
  return { ...preview, text: beforeOnly, limited: true };
}
