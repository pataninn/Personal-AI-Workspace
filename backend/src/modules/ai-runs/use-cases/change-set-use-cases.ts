import { createHash, randomUUID } from 'node:crypto';

import { AiRunNotFoundError } from '@/modules/ai-runs/domain/ai-run-errors';
import {
  ChangeSetAlreadyDecidedError,
  ChangeSetBlockedError,
  ChangeSetConflictError,
  ChangeSetNotFoundError,
  ChangeSetReviewRequiredError,
  ChangeSetValidationError
} from '@/modules/ai-runs/domain/change-errors';
import { CHANGE_SET_LIMITS, isDestructiveOperation } from '@/modules/ai-runs/domain/change-policy';
import type {
  ChangeOperationResult,
  ChangeSetDecisionResult,
  CreateProposedChangeSetRecord,
  ProposedChangeOperation,
  ProposedChangeSet,
  RuntimeChangeProposal
} from '@/modules/ai-runs/domain/change-types';
import type { IAiRunRepository } from '@/modules/ai-runs/repositories/ai-run-repository';
import type { IProposedChangeSetRepository } from '@/modules/ai-runs/repositories/change-set-repository';
import type { IProjectRepository } from '@/modules/projects/repositories/project-repository';
import type { IWorkspaceMutationGateway, WorkspaceFileSnapshot, WorkspaceMutationScope, WorkspaceApplyResult } from '@/modules/ai-runs/repositories/workspace-mutation-gateway';
import { assertActiveAiRunProject } from '@/modules/ai-runs/use-cases/assert-ai-run-project';
import { hashText } from '@/modules/ai-runs/use-cases/manifest-builder';
import { redactSensitiveText, truncateUtf8 } from '@/infrastructure/workspace/workspace-text';
import { WorkspaceRelativePath } from '@/modules/files/domain/workspace-path';
import { isAllowedTextFile } from '@/modules/files/domain/workspace-policy';
import { containsCredentialLikeValue } from '@/shared/egress/redaction';

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
    const scope: WorkspaceMutationScope = { projectId: project.id, relativeRoot: project.relativeRoot };
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
    const sourceHash = source.hash ?? manifestFiles.find((file) => file.relativePath === path)?.sourceHash;
    validateOperation(operation, path, destinationPath, change.content, source, destination, index);
    const expectedSourceHash = requiresSource(operation) ? change.expectedSourceHash ?? sourceHash : undefined;
    const expectedDestinationHash = operation === 'rename' && destination.exists ? change.expectedDestinationHash ?? destination.hash : undefined;
    if (requiresSource(operation) && !expectedSourceHash) {
      throw new ChangeSetBlockedError('The proposed source has no exact current hash.');
    }
    if (change.expectedSourceHash && source.hash !== change.expectedSourceHash) {
      throw new ChangeSetConflictError('The project changed before the proposed change set was collected.');
    }
    const content = change.content;
    const preview = createPreview(operation, source, destination, content ?? '');
    const sizeBytes = Buffer.byteLength(content ?? source.content ?? '', 'utf8');
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
  public constructor(private readonly changeSets: IProposedChangeSetRepository) {}

  public async execute(input: { readonly ownerId: string; readonly runId: string }): Promise<ProposedChangeSet> {
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
    private readonly workspace: IWorkspaceMutationGateway
  ) {}

  public async execute(input: ChangeSetDecisionInput): Promise<ProposedChangeSet> {
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
    return this.applyApprovedSet(decision);
  }

  private async applyApprovedSet(decision: ChangeSetDecisionResult): Promise<ProposedChangeSet> {
    let changeSet = decision.resource;
    const scope: WorkspaceMutationScope = { projectId: changeSet.projectId, relativeRoot: await this.projectRoot(changeSet.ownerId, changeSet.projectId) };
    let applied: WorkspaceApplyResult;
    try {
      applied = await this.workspace.applyChangeSet(scope, changeSet.operations, changeSet.runId, changeSet.proposalHash, {
        recordBackupCheckpoint: async (checkpoint) => {
          const checkpoints = [...(changeSet.backupCheckpoints ?? []), checkpoint];
          const checkpointed: ProposedChangeSet = { ...changeSet, backupCheckpoints: checkpoints, updatedAt: new Date() };
          await this.changeSets.save(checkpointed);
          changeSet = checkpointed;
        }
      });
    } catch {
      return this.saveManualReview(changeSet);
    }
    if (applied.outcome === 'stale') {
      const stale = withStatus(changeSet, 'stale', 'The project changed after this proposal was prepared. No changes from this proposal were applied.');
      await this.changeSets.save(stale);
      throw new ChangeSetConflictError(stale.safeMessage);
    }
    const result = toChangeSetResult(applied);
    const status = applied.outcome === 'needs_manual_review' ? 'needs_manual_review' : applied.outcome === 'failed' ? 'failed' : 'applied';
    const message = status === 'applied'
      ? 'The approved change set was applied and its result was saved.'
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

  private async projectRoot(ownerId: string, projectId: string): Promise<string> {
    const project = await this.projectRepository.findByIdForOwner(ownerId, projectId);
    if (!project || project.status === 'archived') {
      throw new ChangeSetBlockedError('This project is archived and read-only.');
    }
    return project.relativeRoot;
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
  if (!isAllowedTextFile(path, defaultChangePolicy())) {
    throw new ChangeSetBlockedError('Only approved text/code file types can be changed.');
  }
  if (destinationPath && !isAllowedTextFile(destinationPath, defaultChangePolicy())) {
    throw new ChangeSetBlockedError('Only approved text/code file types can be changed.');
  }
  if (operation === 'create' && destination.exists) {
    throw new ChangeSetConflictError('The destination already exists.');
  }
  if (requiresSource(operation) && (!source.exists || source.isDirectory)) {
    throw new ChangeSetConflictError('The source file is missing or is not a regular file.');
  }
  if (operation === 'rename' && destination.isDirectory) {
    throw new ChangeSetConflictError('The destination is a directory.');
  }
}

function requiresSource(operation: RuntimeChangeProposal['operation']): boolean {
  return operation !== 'create';
}

function createPreview(operation: RuntimeChangeProposal['operation'], source: WorkspaceFileSnapshot, destination: WorkspaceFileSnapshot, content: string): ProposedChangeOperation['preview'] {
  const before = redactSensitiveText(source.content ?? '');
  const after = redactSensitiveText(content);
  if (operation === 'create') {
    return boundPreview(after, 'after');
  }
  if (operation === 'delete') {
    return boundPreview(before, 'before');
  }
  if (operation === 'rename') {
    return boundPreview(before, 'diff');
  }
  return boundPreview(makeDiff(before, after), 'diff');
}

function boundPreview(value: string, kind: 'before' | 'after' | 'diff'): ProposedChangeOperation['preview'] {
  const lines = value.split(/\r\n|\r|\n/u);
  const lineLimited = lines.length > CHANGE_SET_LIMITS.maxPreviewLines;
  const lineBounded = lines.slice(0, CHANGE_SET_LIMITS.maxPreviewLines).join('\n');
  const text = truncateUtf8(lineBounded, CHANGE_SET_LIMITS.maxPreviewBytes);
  const limited = lineLimited || text.length !== lineBounded.length;
  return { text, limited, kind };
}

function makeDiff(before: string, after: string): string {
  const beforeLines = before.split(/\r\n|\r|\n/u).map((line) => `- ${line}`);
  const afterLines = after.split(/\r\n|\r|\n/u).map((line) => `+ ${line}`);
  return [...beforeLines, ...afterLines].join('\n');
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
    backupCount: operations.filter((operation) => operation.backup === 'created').length
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

function defaultChangePolicy() {
  return {
    maxPathLength: CHANGE_SET_LIMITS.maxPathLength,
    maxQueryLength: 256,
    maxListEntries: 200,
    maxTreeDepth: 6,
    maxTreeEntries: 1000,
    maxReadBytes: CHANGE_SET_LIMITS.maxContentBytes,
    maxReadLines: CHANGE_SET_LIMITS.maxPreviewLines,
    maxReadOutputBytes: CHANGE_SET_LIMITS.maxPreviewBytes,
    maxSearchFiles: 200,
    maxSearchLines: 20_000,
    maxSearchMatches: 200,
    maxSearchFileBytes: CHANGE_SET_LIMITS.maxContentBytes,
    maxSearchOutputBytes: CHANGE_SET_LIMITS.maxPreviewBytes,
    maxSearchLineBytes: CHANGE_SET_LIMITS.maxPreviewBytes,
    operationTimeoutMs: 5000,
    allowedExtensions: ['.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx', '.json', '.md', '.mjs', '.mts', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml', '.zsh'],
    allowedFileNames: ['dockerfile', 'license', 'makefile', 'readme', 'procfile']
  } as const;
}
