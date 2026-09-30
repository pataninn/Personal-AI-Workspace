import { createHash, randomUUID } from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { ChangeSetDomainError, ChangeSetValidationError } from '@/modules/ai-runs/domain/change-errors';
import { CHANGE_SET_LIMITS, isDestructiveOperation } from '@/modules/ai-runs/domain/change-policy';
import type { BackupCheckpoint, ChangeBackupStatus, ChangeOperationKind, ProposedChangeOperation } from '@/modules/ai-runs/domain/change-types';
import type {
  IWorkspaceMutationGateway,
  WorkspaceApplyResult,
  WorkspaceFileSnapshot,
  WorkspaceMutationApplyOptions,
  WorkspaceMutationScope
} from '@/modules/ai-runs/repositories/workspace-mutation-gateway';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import { DEFAULT_WORKSPACE_INSPECTION_POLICY, isAllowedTextFile } from '@/modules/files/domain/workspace-policy';
import { WorkspaceRelativePath } from '@/modules/files/domain/workspace-path';
import { decodeUtf8 } from '@/infrastructure/workspace/workspace-text';

interface MutationStats {
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isReparsePoint?(): boolean;
}

export interface MutationFileSystem {
  lstat(filePath: string): Promise<MutationStats>;
  realpath(filePath: string): Promise<string>;
  readFile(filePath: string): Promise<Buffer>;
  mkdir(directoryPath: string, options: { readonly recursive: boolean }): Promise<void>;
  open(filePath: string, flags: string): Promise<FileHandle>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  rm(filePath: string, options: { readonly force: boolean }): Promise<void>;
}

const defaultFileSystem: MutationFileSystem = {
  lstat: (filePath) => nodeFs.lstat(filePath),
  realpath: (filePath) => nodeFs.realpath(filePath),
  readFile: (filePath) => nodeFs.readFile(filePath),
  mkdir: async (directoryPath, options) => { await nodeFs.mkdir(directoryPath, options); },
  open: (filePath, flags) => nodeFs.open(filePath, flags),
  rename: (sourcePath, destinationPath) => nodeFs.rename(sourcePath, destinationPath),
  unlink: (filePath) => nodeFs.unlink(filePath),
  rm: (filePath, options) => nodeFs.rm(filePath, options)
};

export interface WorkspaceMutationGatewayOptions {
  readonly containerRoot: string;
  readonly workspaceBoundary: IWorkspaceBoundary;
  readonly recoveryRoot: string;
  readonly fileSystem?: MutationFileSystem;
}

interface PreparedOperation {
  readonly operation: ProposedChangeOperation;
  readonly source: WorkspaceFileSnapshot;
  readonly destination: WorkspaceFileSnapshot;
}

interface ClaimedFile {
  readonly relativePath: string;
  readonly originalPath: string;
  readonly quarantinePath: string;
}

interface ClaimOptions {
  readonly operationId: string;
  readonly checkpoint?: { readonly sizeBytes: number; readonly contentSha256: string };
  readonly recordCheckpoint?: boolean;
  readonly recordBackupCheckpoint?: WorkspaceMutationApplyOptions['recordBackupCheckpoint'];
}

class MutationConflictError extends Error {
  public constructor(public readonly relativePath: string, public readonly reason: string, public readonly backupStatus: ChangeBackupStatus = 'not_required') {
    super(reason);
    this.name = 'MutationConflictError';
  }
}

class BackupMutationError extends Error {
  public constructor(
    message: string,
    public readonly ambiguous: boolean,
  ) {
    super(message);
    this.name = 'BackupMutationError';
  }
}

class AmbiguousMutationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AmbiguousMutationError';
  }
}

class MutationOperationError extends Error {
  public constructor(public readonly backupStatus: ChangeBackupStatus, public readonly ambiguous: boolean) {
    super('The file operation could not be completed safely.');
    this.name = 'MutationOperationError';
  }
}

export class WorkspaceMutationGatewayAdapter implements IWorkspaceMutationGateway {
  private readonly fileSystem: MutationFileSystem;

  public constructor(private readonly options: WorkspaceMutationGatewayOptions) {
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
  }

  public async inspect(scope: WorkspaceMutationScope, relativePath: string): Promise<WorkspaceFileSnapshot> {
    const context = await this.resolveContext(scope);
    const normalizedPath = this.parseFilePath(relativePath);
    const target = await this.resolveTarget(context, normalizedPath, true);
    if (!target.exists) {
      return { path: normalizedPath, exists: false, isDirectory: false, sizeBytes: 0 };
    }
    return this.readSnapshot(normalizedPath, target.absolutePath, target.stats);
  }

  public async applyChangeSet(
    scope: WorkspaceMutationScope,
    operations: readonly ProposedChangeOperation[],
    runId: string,
    proposalHash: string,
    options: WorkspaceMutationApplyOptions = {}
  ): Promise<WorkspaceApplyResult> {
    this.validateExactPreconditions(operations);
    const context = await this.resolveContext(scope);
    let prepared: readonly PreparedOperation[];
    try {
      prepared = await this.preflight(context, operations);
    } catch (error: unknown) {
      if (error instanceof MutationConflictError) {
        return {
          outcome: 'stale',
          conflict: { path: error.relativePath, reason: error.reason },
          operations: operations.map((operation) => ({
            operationId: operation.operationId,
            operation: operation.operation,
            path: operation.path,
            ...(operation.destinationPath ? { destinationPath: operation.destinationPath } : {}),
            status: 'skipped' as const,
            backup: backupBeforeOperation(operation),
            safeMessage: 'The change set is stale and was not applied.'
          })),
        };
      }
      throw error;
    }
    const results: WorkspaceApplyResult['operations'][number][] = [];
    for (const item of prepared) {
      try {
        results.push(await this.applyOne(context, item, runId, proposalHash, options));
      } catch (error: unknown) {
        if (error instanceof MutationConflictError) {
          results.push(this.failureResult(item.operation, 'skipped', 'The change set became stale before this operation could run.', error.backupStatus));
          results.push(...remainingResults(prepared, prepared.indexOf(item), 'skipped'));
          return {
            outcome: 'stale',
            conflict: { path: error.relativePath, reason: error.reason },
            operations: results
          };
        }
        const ambiguous = error instanceof MutationOperationError && error.ambiguous
          || error instanceof AmbiguousMutationError
          || (error instanceof BackupMutationError && error.ambiguous);
        const outcome = ambiguous ? 'needs_manual_review' : 'failed';
        const safeMessage = ambiguous
          ? 'The file operation outcome could not be confirmed.'
          : 'The file operation failed before completion.';
        const backup: ChangeBackupStatus = error instanceof BackupMutationError
          ? (error.ambiguous ? 'unknown' : 'failed')
          : error instanceof MutationOperationError
            ? error.backupStatus
            : backupBeforeOperation(item.operation);
        results.push(this.failureResult(item.operation, outcome, safeMessage, backup));
        results.push(...remainingResults(prepared, prepared.indexOf(item), 'skipped'));
        return { outcome, operations: results };
      }
    }
    return { outcome: 'applied', operations: results };
  }

  private async resolveContext(scope: WorkspaceMutationScope): Promise<{ readonly projectRoot: string; readonly canonicalRoot: string }> {
    await this.options.workspaceBoundary.assertReady();
    const relativeRoot = await this.options.workspaceBoundary.validateProjectRoot(scope.relativeRoot);
    const canonicalRoot = await this.fileSystem.realpath(this.options.containerRoot);
    const projectPath = path.resolve(this.options.containerRoot, ...relativeRoot.split('/'));
    const projectRoot = await this.fileSystem.realpath(projectPath);
    const isWorkspaceRootProject = relativeRoot === '.';
    const isValidProjectRoot = isWorkspaceRootProject
      ? canonicalRoot === projectRoot
      : isContained(canonicalRoot, projectRoot) && canonicalRoot !== projectRoot;
    if (!isValidProjectRoot) {
      throw new ChangeSetValidationError([{ field: 'relativeRoot', message: 'The project root is outside the authoritative workspace.' }]);
    }
    return { projectRoot, canonicalRoot };
  }

  private async preflight(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    operations: readonly ProposedChangeOperation[]
  ): Promise<readonly PreparedOperation[]> {
    if (operations.length === 0 || operations.length > CHANGE_SET_LIMITS.maxOperations) {
      throw new ChangeSetValidationError([{ field: 'operations', message: 'The change set operation count is outside the safe limit.' }]);
    }
    const prepared: PreparedOperation[] = [];
    const touched = new Set<string>();
    for (const operation of operations) {
      const key = `${operation.operation}:${operation.path}:${operation.destinationPath ?? ''}`;
      if (touched.has(key)) {
        throw new ChangeSetValidationError([{ field: 'operations', message: 'The change set contains a duplicate operation.' }]);
      }
      touched.add(key);
      const source = await this.inspectPrepared(context, operation.path);
      const destination = operation.operation === 'rename' && operation.destinationPath
        ? await this.inspectPrepared(context, operation.destinationPath)
        : source;
      this.assertPrecondition(operation, source, destination);
      prepared.push({ operation, source, destination });
    }
    return prepared;
  }

  private async inspectPrepared(context: { readonly projectRoot: string; readonly canonicalRoot: string }, relativePath: string): Promise<WorkspaceFileSnapshot> {
    const normalizedPath = this.parseFilePath(relativePath);
    const target = await this.resolveTarget(context, normalizedPath, true);
    if (!target.exists) {
      return missingSnapshot(normalizedPath);
    }
    return this.readSnapshot(normalizedPath, target.absolutePath, target.stats);
  }

  private assertPrecondition(operation: ProposedChangeOperation, source: WorkspaceFileSnapshot, destination: WorkspaceFileSnapshot): void {
    const backupStatus = backupBeforeOperation(operation);
    if (operation.operation === 'create') {
      if (source.exists) {
        throw new MutationConflictError(operation.path, 'Destination now exists.', backupStatus);
      }
      return;
    }
    if (!source.exists || source.isDirectory) {
      throw new MutationConflictError(operation.path, 'Source is missing or is not a file.', backupStatus);
    }
    if (source.hash !== operation.expectedSourceHash) {
      throw new MutationConflictError(operation.path, 'Source changed after this proposal was prepared.', backupStatus);
    }
    if (operation.operation === 'rename') {
      if (operation.destinationPresent !== destination.exists) {
        throw new MutationConflictError(operation.destinationPath ?? operation.path, destination.exists ? 'Destination now exists.' : 'Destination is missing.', backupStatus);
      }
      if (destination.exists && destination.hash !== operation.expectedDestinationHash) {
        throw new MutationConflictError(operation.destinationPath ?? operation.path, 'Destination changed after this proposal was prepared.', backupStatus);
      }
      if (destination.isDirectory) {
        throw new MutationConflictError(operation.destinationPath ?? operation.path, 'Destination is a directory.', backupStatus);
      }
    }
  }

  private validateExactPreconditions(operations: readonly ProposedChangeOperation[]): void {
    for (const operation of operations) {
      if (operation.operation === 'create') {
        if (operation.expectedSourceHash || operation.expectedDestinationHash || operation.sourcePresent || operation.destinationPresent) {
          throw new ChangeSetValidationError([{ field: `operations.${operation.operationId}`, message: 'Create operations must carry an exact empty-destination precondition.' }]);
        }
        continue;
      }
      if (!isSha256(operation.expectedSourceHash)) {
        throw new ChangeSetValidationError([{ field: `operations.${operation.operationId}.expectedSourceHash`, message: 'A current SHA-256 source precondition is required.' }]);
      }
      if (operation.operation === 'rename') {
        if (operation.destinationPresent && !isSha256(operation.expectedDestinationHash)) {
          throw new ChangeSetValidationError([{ field: `operations.${operation.operationId}.expectedDestinationHash`, message: 'An occupied rename destination requires an exact SHA-256 precondition.' }]);
        }
        if (!operation.destinationPresent && operation.expectedDestinationHash !== undefined) {
          throw new ChangeSetValidationError([{ field: `operations.${operation.operationId}.expectedDestinationHash`, message: 'An empty rename destination cannot carry a destination hash.' }]);
        }
      }
    }
  }

  private async applyOne(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    prepared: PreparedOperation,
    runId: string,
    proposalHash: string,
    options: WorkspaceMutationApplyOptions
  ): Promise<WorkspaceApplyResult['operations'][number]> {
    const operation = prepared.operation;
    const latestSource = await this.recheck(context, operation.path);
    const latestDestination = operation.destinationPath ? await this.recheck(context, operation.destinationPath) : missingSnapshot(operation.path);
    this.assertPrecondition(operation, latestSource, latestDestination);
    const backupRequired = isDestructiveOperation(operation.operation, latestDestination.exists);
    const backup = backupRequired ? await this.createBackups(context, operation, latestSource, latestDestination, runId, proposalHash, options) : { status: 'not_required' as const };
    try {
      if (operation.operation === 'delete') {
        await this.deleteFile(context, operation.path, operation.expectedSourceHash, operation.operationId);
      } else if (operation.operation === 'rename') {
        await this.renameFile(context, operation.path, operation.destinationPath ?? '', operation.expectedSourceHash, operation.expectedDestinationHash, operation.operationId, latestSource.sizeBytes, options);
      } else if (operation.operation === 'overwrite') {
        await this.overwriteFile(context, operation.path, operation.content ?? '', operation.expectedSourceHash, operation.operationId);
      } else {
        await this.writeFile(context, operation.path, operation.content ?? '', operation.operation === 'create' ? undefined : operation.expectedSourceHash);
      }
    } catch (error: unknown) {
      if (error instanceof MutationConflictError) {
        throw new MutationConflictError(error.relativePath, error.reason, backup.status);
      }
      throw new MutationOperationError(backup.status, error instanceof AmbiguousMutationError);
    }
    return {
      operationId: operation.operationId,
      operation: operation.operation,
      path: operation.path,
      ...(operation.destinationPath ? { destinationPath: operation.destinationPath } : {}),
      status: 'applied',
      backup: backup.status,
      ...(backup.status === 'created' && backup.reference ? { backupReference: backup.reference } : {}),
      safeMessage: messageFor(operation.operation, backup.status)
    };
  }

  private async recheck(context: { readonly projectRoot: string; readonly canonicalRoot: string }, relativePath: string): Promise<WorkspaceFileSnapshot> {
    return this.inspectPrepared(context, relativePath);
  }

  private async createBackups(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    operation: ProposedChangeOperation,
    source: WorkspaceFileSnapshot,
    destination: WorkspaceFileSnapshot,
    runId: string,
    proposalHash: string,
    options: WorkspaceMutationApplyOptions
  ): Promise<{ readonly status: 'created'; readonly reference?: string }> {
    const checkpoints: BackupCheckpoint[] = [];
    try {
      if (source.exists && source.content !== undefined) {
        checkpoints.push(await this.writeBackup(context, runId, proposalHash, operation.operationId, operation.path, source.content, source.hash));
      }
      if (operation.operation === 'rename' && destination.exists && destination.content !== undefined) {
        checkpoints.push(await this.writeBackup(context, runId, proposalHash, operation.operationId, operation.destinationPath ?? operation.path, destination.content, destination.hash));
      }
      for (const checkpoint of checkpoints) {
        try {
          await options.recordBackupCheckpoint?.(checkpoint);
        } catch {
          throw new AmbiguousMutationError('The recovery checkpoint could not be persisted before mutation.');
        }
      }
      return { status: 'created', ...(checkpoints[0]?.reference ? { reference: checkpoints[0].reference } : {}) };
    } catch (error: unknown) {
      if (error instanceof MutationConflictError) {
        if (checkpoints.length > 0) {
          throw new MutationConflictError(error.relativePath, error.reason, 'created');
        }
        throw error;
      }
      if (error instanceof AmbiguousMutationError) {
        throw error;
      }
      if (error instanceof BackupMutationError) {
        throw error;
      }
      throw new BackupMutationError('Recovery snapshot creation failed.', true);
    }
  }

  private async writeBackup(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    runId: string,
    proposalHash: string,
    operationId: string,
    relativePath: string,
    content: string,
    expectedHash: string | undefined
  ): Promise<BackupCheckpoint> {
    const latest = await this.finalSnapshot(context, relativePath, expectedHash, false);
    if (!latest.exists || latest.content !== content) {
      throw new MutationConflictError(relativePath, 'Source changed before the recovery snapshot was created.');
    }
    const backupDirectory = path.resolve(this.options.recoveryRoot, `run-${runId}`, proposalHash, operationId);
    await this.fileSystem.mkdir(backupDirectory, { recursive: true });
    const safeName = relativePath.replaceAll('/', '__');
    const backupPath = path.resolve(backupDirectory, `${safeName}.bak`);
    await this.assertRecoveryPath(backupPath, true);
    const handle = await this.fileSystem.open(backupPath, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.assertRecoveryPath(backupPath, false);
    const written = await this.fileSystem.readFile(backupPath);
    if (!written.equals(Buffer.from(content, 'utf8'))) {
      throw new BackupMutationError('Recovery snapshot verification failed.', true);
    }
    return {
      reference: path.relative(this.options.recoveryRoot, backupPath).replaceAll(path.sep, '/'),
      operationId,
      path: relativePath,
      sizeBytes: written.length,
      contentSha256: createHash('sha256').update(written).digest('hex'),
      createdAt: new Date()
    };
  }

  private async overwriteFile(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    relativePath: string,
    content: string,
    expectedHash: string | undefined,
    operationId: string
  ): Promise<void> {
    const claim = await this.claimAndValidate(context, relativePath, expectedHash, { operationId });
    try {
      await this.writeFile(context, relativePath, content, undefined);
      await this.releaseClaim(context, claim, expectedHash);
    } catch (error: unknown) {
      await this.restoreClaimOrManual(context, claim);
      if (error instanceof ChangeSetDomainError || error instanceof MutationConflictError) {
        throw error;
      }
      throw new AmbiguousMutationError('The overwrite outcome could not be confirmed.');
    }
  }

  private async writeFile(context: { readonly projectRoot: string; readonly canonicalRoot: string }, relativePath: string, content: string, expectedHash: string | undefined): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > CHANGE_SET_LIMITS.maxContentBytes) {
      throw new ChangeSetValidationError([{ field: 'content', message: 'The proposed file content is too large.' }]);
    }
    const normalizedPath = this.parseFilePath(relativePath);
    const current = await this.finalSnapshot(context, normalizedPath, expectedHash, expectedHash === undefined);
    if (!expectedHash && current.exists) {
      throw new MutationConflictError(relativePath, 'Destination appeared during apply.');
    }
    await this.writeAtomic(context, normalizedPath, content, expectedHash);
  }

  private async writeAtomic(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    relativePath: string,
    content: string,
    expectedHash: string | undefined
  ): Promise<void> {
    await this.finalSnapshot(context, relativePath, expectedHash, expectedHash === undefined);
    const temporaryPath = path.join(path.dirname(path.resolve(context.projectRoot, ...relativePath.split('/'))), `.${path.basename(relativePath)}.pai-${randomUUID()}.tmp`);
    await this.assertAbsoluteBoundary(context, temporaryPath, true);
    let handle: FileHandle | undefined;
    try {
      await this.assertFinalTarget(context, relativePath, expectedHash);
      handle = await this.fileSystem.open(temporaryPath, 'wx');
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.assertAbsoluteBoundary(context, temporaryPath, false);
      const latestTarget = await this.assertAbsoluteBoundary(context, path.resolve(context.projectRoot, ...relativePath.split('/')), true);
      const latest = await this.snapshotAfterBoundary(relativePath, latestTarget, expectedHash, expectedHash === undefined);
      if ((expectedHash === undefined && latest.exists) || (expectedHash !== undefined && latest.hash !== expectedHash)) {
        throw new MutationConflictError(relativePath, 'The target changed before the atomic rename.');
      }
      await this.fileSystem.rename(temporaryPath, latestTarget.absolutePath);
    } catch (error: unknown) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await this.fileSystem.rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof ChangeSetDomainError || error instanceof MutationConflictError) {
        throw error;
      }
      throw new AmbiguousMutationError('The atomic file replacement outcome could not be confirmed.');
    }
  }

  private async deleteFile(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    relativePath: string,
    expectedHash: string | undefined,
    operationId: string
  ): Promise<void> {
    const claim = await this.claimAndValidate(context, relativePath, expectedHash, { operationId });
    try {
      await this.releaseClaim(context, claim, expectedHash);
    } catch (error: unknown) {
      await this.restoreClaimOrManual(context, claim);
      if (error instanceof ChangeSetDomainError || error instanceof MutationConflictError) {
        throw error;
      }
      throw new AmbiguousMutationError('The delete outcome could not be confirmed.');
    }
  }

  private async renameFile(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    sourcePath: string,
    destinationPath: string,
    expectedSourceHash: string | undefined,
    expectedDestinationHash: string | undefined,
    operationId: string,
    sourceSizeBytes: number,
    options: WorkspaceMutationApplyOptions
  ): Promise<void> {
    const sourceClaim = await this.claimAndValidate(context, sourcePath, expectedSourceHash, {
      operationId,
      checkpoint: { sizeBytes: sourceSizeBytes, contentSha256: expectedSourceHash ?? '' },
      recordCheckpoint: expectedDestinationHash === undefined,
      recordBackupCheckpoint: options.recordBackupCheckpoint
    });
    let destinationClaim: ClaimedFile | undefined;
    let promoted = false;
    try {
      if (expectedDestinationHash !== undefined) {
        destinationClaim = await this.claimAndValidate(context, destinationPath, expectedDestinationHash, { operationId });
      }
      const source = await this.assertAbsoluteBoundary(context, sourceClaim.quarantinePath, false);
      const destination = await this.assertAbsoluteBoundary(context, path.resolve(context.projectRoot, ...destinationPath.split('/')), true);
      let claimedDestination: { readonly absolutePath: string; readonly exists: boolean; readonly stats: MutationStats } | undefined;
      if (destinationClaim) {
        claimedDestination = await this.assertAbsoluteBoundary(context, destinationClaim.quarantinePath, false);
      }
      if (destination.exists) {
        throw new MutationConflictError(destinationPath, 'Destination appeared before the rename promotion.');
      }
      await this.snapshotAfterBoundary(sourcePath, source, expectedSourceHash, false);
      if (claimedDestination) {
        await this.snapshotAfterBoundary(destinationPath, claimedDestination, expectedDestinationHash, false);
      }
      await this.fileSystem.rename(source.absolutePath, destination.absolutePath);
      promoted = true;
      if (destinationClaim) {
        await this.releaseClaim(context, destinationClaim, expectedDestinationHash);
      }
    } catch (error: unknown) {
      if (!promoted) {
        await this.restoreClaimOrManual(context, sourceClaim);
      }
      if (destinationClaim && !promoted) {
        await this.restoreClaimOrManual(context, destinationClaim);
      }
      if (error instanceof ChangeSetDomainError || error instanceof MutationConflictError) {
        throw error;
      }
      throw new AmbiguousMutationError('The rename outcome could not be confirmed.');
    }
  }

  private async claimAndValidate(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    relativePath: string,
    expectedHash: string | undefined,
    options: ClaimOptions
  ): Promise<ClaimedFile> {
    if (!expectedHash) {
      throw new ChangeSetValidationError([{ field: `operations.${options.operationId}.expectedSourceHash`, message: 'A current SHA-256 source precondition is required before claiming a file.' }]);
    }
    const normalizedPath = this.parseFilePath(relativePath);
    const originalPath = path.resolve(context.projectRoot, ...normalizedPath.split('/'));
    const quarantinePath = path.join(path.dirname(originalPath), `.${path.basename(originalPath)}.pai-${randomUUID()}.claim`);
    if (options.recordCheckpoint && options.recordBackupCheckpoint) {
      try {
        await options.recordBackupCheckpoint({
          reference: path.relative(this.options.containerRoot, quarantinePath).replaceAll(path.sep, '/'),
          operationId: options.operationId,
          path: normalizedPath,
          sizeBytes: options.checkpoint?.sizeBytes ?? 0,
          contentSha256: options.checkpoint?.contentSha256 ?? expectedHash,
          createdAt: new Date()
        });
      } catch {
        throw new AmbiguousMutationError('The claim checkpoint could not be persisted before mutation.');
      }
    }
    let claimed = false;
    const claim = { relativePath: normalizedPath, originalPath, quarantinePath } satisfies ClaimedFile;
    try {
      const source = await this.assertAbsoluteBoundary(context, originalPath, false);
      const quarantine = await this.assertAbsoluteBoundary(context, quarantinePath, true);
      if (quarantine.exists) {
        throw new AmbiguousMutationError('The private claim path is unexpectedly occupied.');
      }
      await this.fileSystem.rename(source.absolutePath, quarantine.absolutePath);
      claimed = true;
      const claimedTarget = await this.assertAbsoluteBoundary(context, quarantinePath, false);
      const snapshot = await this.snapshotAfterBoundary(normalizedPath, claimedTarget, expectedHash, false);
      if (!snapshot.exists || snapshot.hash !== expectedHash) {
        throw new MutationConflictError(normalizedPath, 'The claimed file changed before mutation.');
      }
      return claim;
    } catch (error: unknown) {
      if (claimed) {
        await this.restoreClaimOrManual(context, claim);
      }
      if (error instanceof ChangeSetDomainError || error instanceof MutationConflictError) {
        throw error;
      }
      throw new AmbiguousMutationError('The file claim outcome could not be confirmed.');
    }
  }

  private async releaseClaim(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    claim: ClaimedFile,
    expectedHash: string | undefined
  ): Promise<void> {
    const target = await this.assertAbsoluteBoundary(context, claim.quarantinePath, false);
    await this.snapshotAfterBoundary(claim.relativePath, target, expectedHash, false);
    await this.fileSystem.unlink(target.absolutePath);
  }

  private async restoreClaimOrManual(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    claim: ClaimedFile
  ): Promise<void> {
    try {
      const original = await this.assertAbsoluteBoundary(context, claim.originalPath, true);
      if (original.exists) {
        throw new AmbiguousMutationError('The original path is occupied; the claimed file cannot be restored safely.');
      }
      const quarantine = await this.assertAbsoluteBoundary(context, claim.quarantinePath, false);
      const destination = await this.assertAbsoluteBoundary(context, claim.originalPath, true);
      if (destination.exists) {
        throw new AmbiguousMutationError('The original path appeared during claim restoration.');
      }
      await this.fileSystem.rename(quarantine.absolutePath, claim.originalPath);
    } catch {
      throw new AmbiguousMutationError('The claimed file could not be restored safely.');
    }
  }

  private async resolveTarget(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    relativePath: string,
    allowMissing: boolean
  ): Promise<{ readonly absolutePath: string; readonly exists: boolean; readonly stats: MutationStats }> {
    const absolutePath = path.resolve(context.projectRoot, ...relativePath.split('/'));
    return this.assertAbsoluteBoundary(context, absolutePath, allowMissing);
  }

  /**
   * This is intentionally called immediately before every authoritative open,
   * rename, or unlink. MVP1 can fail closed against injected trusted-process
   * races; a hostile local process still requires handle-relative Windows APIs.
   */
  private async assertAbsoluteBoundary(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    absolutePath: string,
    allowMissing: boolean
  ): Promise<{ readonly absolutePath: string; readonly exists: boolean; readonly stats: MutationStats }> {
    if (!isContained(context.projectRoot, absolutePath, true)) {
      throw new ChangeSetValidationError([{ field: 'path', message: 'The path is outside the project.' }]);
    }
    await this.assertParents(context, absolutePath);
    try {
      const stats = await this.fileSystem.lstat(absolutePath);
      assertSafeStats(stats);
      const canonical = await this.fileSystem.realpath(absolutePath);
      if (!isContained(context.projectRoot, canonical, true) || !isContained(context.canonicalRoot, canonical, true)) {
        throw new ChangeSetValidationError([{ field: 'path', message: 'The path resolves outside the project.' }]);
      }
      return { absolutePath: canonical, exists: true, stats };
    } catch (error: unknown) {
      if (isMissing(error) && allowMissing) {
        return { absolutePath, exists: false, stats: missingStats() };
      }
      throw error;
    }
  }

  private async finalSnapshot(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    relativePath: string,
    expectedHash: string | undefined,
    allowMissing: boolean
  ): Promise<WorkspaceFileSnapshot> {
    const normalizedPath = this.parseFilePath(relativePath);
    const target = await this.assertAbsoluteBoundary(context, path.resolve(context.projectRoot, ...normalizedPath.split('/')), allowMissing);
    if (!target.exists) {
      if (expectedHash !== undefined) {
        throw new MutationConflictError(normalizedPath, 'Source is missing during the final safety check.');
      }
      return missingSnapshot(normalizedPath);
    }
    const snapshot = await this.readSnapshot(normalizedPath, target.absolutePath, target.stats);
    if (expectedHash !== undefined && snapshot.hash !== expectedHash) {
      throw new MutationConflictError(normalizedPath, 'The file hash changed during the final safety check.');
    }
    return snapshot;
  }

  /**
   * Read the final hash or occupancy only after all final boundary checks have
   * completed. Keep this as the last validation step before a filesystem side
   * effect; a trailing lstat after this read would reopen the TOCTOU window.
   */
  private async snapshotAfterBoundary(
    relativePath: string,
    target: { readonly absolutePath: string; readonly exists: boolean; readonly stats: MutationStats },
    expectedHash: string | undefined,
    allowMissing: boolean
  ): Promise<WorkspaceFileSnapshot> {
    const normalizedPath = this.parseFilePath(relativePath);
    if (!target.exists) {
      if (expectedHash !== undefined || !allowMissing) {
        throw new MutationConflictError(normalizedPath, 'Source is missing during the final safety check.');
      }
      return missingSnapshot(normalizedPath);
    }
    const snapshot = await this.readSnapshot(normalizedPath, target.absolutePath, target.stats);
    if (expectedHash !== undefined && snapshot.hash !== expectedHash) {
      throw new MutationConflictError(normalizedPath, 'The file hash changed during the final safety check.');
    }
    return snapshot;
  }

  private async assertFinalTarget(
    context: { readonly projectRoot: string; readonly canonicalRoot: string },
    relativePath: string,
    expectedHash: string | undefined
  ): Promise<{ readonly absolutePath: string; readonly exists: boolean; readonly stats: MutationStats }> {
    const target = await this.assertAbsoluteBoundary(context, path.resolve(context.projectRoot, ...relativePath.split('/')), expectedHash === undefined);
    if (expectedHash === undefined) {
      if (target.exists) {
        throw new MutationConflictError(relativePath, 'Destination appeared during the final safety check.');
      }
      return target;
    }
    if (!target.exists) {
      throw new MutationConflictError(relativePath, 'Source is missing during the final safety check.');
    }
    const snapshot = await this.readSnapshot(relativePath, target.absolutePath, target.stats);
    if (snapshot.hash !== expectedHash) {
      throw new MutationConflictError(relativePath, 'Source changed during the final safety check.');
    }
    return target;
  }

  private async assertRecoveryPath(filePath: string, allowMissing: boolean): Promise<void> {
    const recoveryRoot = path.resolve(this.options.recoveryRoot);
    const resolved = path.resolve(filePath);
    if (!isContained(recoveryRoot, resolved, true)) {
      throw new BackupMutationError('The recovery snapshot path is outside the private recovery root.', false);
    }
    let current = recoveryRoot;
    const relative = path.relative(recoveryRoot, resolved);
    const segments = relative.length === 0 ? [] : relative.split(path.sep);
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        const stats = await this.fileSystem.lstat(current);
        assertSafeStats(stats);
        const canonical = await this.fileSystem.realpath(current);
        if (!isContained(recoveryRoot, canonical, true)) {
          throw new BackupMutationError('The recovery snapshot path resolves outside the private recovery root.', false);
        }
      } catch (error: unknown) {
        if (isMissing(error) && allowMissing) {
          return;
        }
        throw error;
      }
    }
  }

  private async assertParents(context: { readonly projectRoot: string; readonly canonicalRoot: string }, absolutePath: string): Promise<void> {
    const relative = path.relative(context.projectRoot, path.dirname(absolutePath));
    const segments = relative.length === 0 ? [] : relative.split(path.sep);
    let current = context.projectRoot;
    for (const segment of segments) {
      current = path.join(current, segment);
      const stats = await this.fileSystem.lstat(current);
      assertSafeStats(stats);
      if (!stats.isDirectory()) {
        throw new ChangeSetValidationError([{ field: 'path', message: 'The target parent is not a directory.' }]);
      }
      const canonical = await this.fileSystem.realpath(current);
      if (!isContained(context.projectRoot, canonical, true) || !isContained(context.canonicalRoot, canonical, true)) {
        throw new ChangeSetValidationError([{ field: 'path', message: 'The target parent is outside the project.' }]);
      }
    }
  }

  private async readSnapshot(relativePath: string, absolutePath: string, stats: MutationStats): Promise<WorkspaceFileSnapshot> {
    if (stats.isDirectory()) {
      return { path: relativePath, exists: true, isDirectory: true, sizeBytes: 0 };
    }
    if (!stats.isFile() || stats.size > CHANGE_SET_LIMITS.maxContentBytes) {
      throw new ChangeSetValidationError([{ field: 'path', message: 'The target is not a supported bounded text file.' }]);
    }
    const bytes = await this.fileSystem.readFile(absolutePath);
    if (bytes.length > CHANGE_SET_LIMITS.maxContentBytes) {
      throw new ChangeSetValidationError([{ field: 'path', message: 'The target file is too large.' }]);
    }
    const content = decodeUtf8(bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    return { path: relativePath, exists: true, isDirectory: false, sizeBytes: bytes.length, content, hash };
  }

  private parseFilePath(value: string): string {
    const parsed = WorkspaceRelativePath.parse(value, { maxLength: CHANGE_SET_LIMITS.maxPathLength });
    if (!isAllowedTextFile(parsed.value, {
      ...DEFAULT_WORKSPACE_INSPECTION_POLICY,
      maxPathLength: CHANGE_SET_LIMITS.maxPathLength,
      maxReadBytes: CHANGE_SET_LIMITS.maxContentBytes,
      maxReadOutputBytes: CHANGE_SET_LIMITS.maxPreviewBytes,
      maxReadLines: CHANGE_SET_LIMITS.maxPreviewLines,
    })) {
      throw new ChangeSetValidationError([{ field: 'path', message: 'Only approved text/code file types can be changed.' }]);
    }
    return parsed.value;
  }

  private failureResult(operation: ProposedChangeOperation, status: 'applied' | 'skipped' | 'failed' | 'needs_manual_review', safeMessage: string, backup: ChangeBackupStatus = backupBeforeOperation(operation)): WorkspaceApplyResult['operations'][number] {
    return { operationId: operation.operationId, operation: operation.operation, path: operation.path, ...(operation.destinationPath ? { destinationPath: operation.destinationPath } : {}), status, backup, safeMessage };
  }
}

function remainingResults(prepared: readonly PreparedOperation[], completedIndex: number, status: 'skipped'): WorkspaceApplyResult['operations'] {
  return prepared.slice(completedIndex + 1).map((item) => ({ operationId: item.operation.operationId, operation: item.operation.operation, path: item.operation.path, ...(item.operation.destinationPath ? { destinationPath: item.operation.destinationPath } : {}), status, backup: backupBeforeOperation(item.operation), safeMessage: 'The change set did not continue after an earlier failure.' }));
}

function backupBeforeOperation(operation: ProposedChangeOperation): ChangeBackupStatus {
  return operation.backupRequired ? 'not_created' : 'not_required';
}

function messageFor(operation: ChangeOperationKind, backup: ChangeBackupStatus): string {
  if (operation === 'overwrite') return backup === 'created' ? 'Overwritten after a recovery snapshot.' : 'Overwritten.';
  if (operation === 'rename') return backup === 'created' ? 'Renamed after a recovery snapshot.' : 'Renamed.';
  if (operation === 'delete') return backup === 'created' ? 'Deleted after a recovery snapshot.' : 'Deleted.';
  return operation === 'create' ? 'Created.' : 'Edited.';
}

function missingSnapshot(relativePath: string): WorkspaceFileSnapshot {
  return { path: relativePath, exists: false, isDirectory: false, sizeBytes: 0 };
}

function missingStats(): MutationStats {
  return { size: 0, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false };
}

function assertSafeStats(stats: MutationStats): void {
  if (stats.isSymbolicLink() || stats.isReparsePoint?.() === true) {
    throw new ChangeSetValidationError([{ field: 'path', message: 'Reparse points are not safe to mutate.' }]);
  }
}

function isSha256(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isContained(root: string, target: string, allowRoot = false): boolean {
  const relative = path.relative(root, target);
  return (allowRoot && relative.length === 0) || (relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
