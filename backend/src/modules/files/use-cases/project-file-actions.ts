import { createHash, randomUUID } from 'node:crypto';
import type { IProjectFileAccess, IProjectFileGateway, ProjectFileMutationAccess } from '@/modules/files/repositories/project-file-access';
import type { IDocumentMarkdownConverter } from '@/modules/files/repositories/document-markdown-converter';
import { WorkspaceRelativePath } from '@/modules/files/domain/workspace-path';
import { WorkspaceDomainError } from '@/modules/files/domain/workspace-errors';
import { storageFileOperationFingerprint } from '@/modules/storage-quotas/domain/storage-file-operation-fingerprint';
import type { StorageFileOperationCommand, StorageFileReferencePlan, StorageTrustedFileScope, StorageVerifiedFileChange } from '@/modules/storage-quotas/domain/storage-quota-types';
import { AppError } from '@/shared/errors/app-error';
import { StorageQuotaFileMutation, StorageQuotaNoSideEffectError } from '@/infrastructure/workspace/storage-quota-file-mutation';

const CONVERTIBLE_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.xls', '.epub']);
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;

interface FileActionInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly path: string;
}

interface ExistingFile {
  readonly bytes: Buffer;
  readonly hash: string;
}

/** User-triggered file operations, independently scoped from AI context selection. */
export class ProjectFileActions {
  public constructor(
    private readonly access: IProjectFileAccess,
    private readonly gateway: IProjectFileGateway,
    private readonly converter: IDocumentMarkdownConverter,
    private readonly storageMutations: StorageQuotaFileMutation
  ) {}

  public download(input: FileActionInput): Promise<{ readonly bytes: Buffer; readonly hash: string }> {
    const filePath = normalizePath(input.path);
    return this.access.execute(input, (scope) => this.gateway.download(scope, filePath));
  }

  public async write(input: FileActionInput & { readonly bytes: Buffer; readonly expectedHash: string | null }): Promise<{ readonly hash: string }> {
    validatePayload(input.bytes, MAX_TEXT_BYTES);
    validateHash(input.expectedHash);
    const filePath = normalizePath(input.path);
    const access = await this.access.authorizeMutation(input);
    const prior = await this.readPrior(access.scope, filePath);
    assertExpectedFile(input.expectedHash, prior);
    const command = createCommand(access, filePath, prior, input.bytes);
    const result = await this.storageMutations.execute(command, access.resolveTrustedScope, async (trusted) => {
      const scope = trustedProjectScope(trusted, access);
      let written: { readonly hash: string };
      try {
        written = await this.gateway.write(scope, { path: filePath, bytes: input.bytes, expectedHash: input.expectedHash });
      } catch (error: unknown) {
        if (isKnownNoSideEffect(error)) throw new StorageQuotaNoSideEffectError(error);
        throw error;
      }
      const verified = await this.gateway.download(scope, filePath);
      if (verified.hash !== written.hash || !verified.bytes.equals(input.bytes)) throw new Error('The written file could not be verified.');
      return { result: written, changes: [verifiedChange(command.changes[0], verified.bytes.length, verified.hash)] };
    });
    if (result.state === 'applied') await access.recordActivity();
    return { hash: result.state === 'applied' ? result.result.hash : intendedHash(command.changes[0]) };
  }

  public async upload(input: FileActionInput & { readonly bytes: Buffer }): Promise<{ readonly path: string; readonly converted: boolean }> {
    validatePayload(input.bytes, MAX_UPLOAD_BYTES);
    const sourcePath = normalizePath(input.path);
    const extension = extensionOf(sourcePath);
    const converted = CONVERTIBLE_DOCUMENT_EXTENSIONS.has(extension);
    const targetPath = converted ? `${sourcePath.slice(0, -extension.length)}.md` : sourcePath;
    const access = await this.access.authorizeMutation(input);
    const bytes = converted ? await this.converter.convert({ fileName: sourcePath, bytes: input.bytes }) : input.bytes;
    validatePayload(bytes, MAX_UPLOAD_BYTES);
    const prior = await this.readPrior(access.scope, targetPath);
    assertExpectedFile(null, prior);
    const command = createCommand(access, targetPath, prior, bytes);
    const result = await this.storageMutations.execute(command, access.resolveTrustedScope, async (trusted) => {
      const scope = trustedProjectScope(trusted, access);
      let written: { readonly hash: string };
      try {
        written = await this.gateway.write(scope, { path: targetPath, bytes, expectedHash: null });
      } catch (error: unknown) {
        if (isKnownNoSideEffect(error)) throw new StorageQuotaNoSideEffectError(error);
        throw error;
      }
      const verified = await this.gateway.download(scope, targetPath);
      if (verified.hash !== written.hash || !verified.bytes.equals(bytes)) throw new Error('The uploaded file could not be verified.');
      return { result: undefined, changes: [verifiedChange(command.changes[0], verified.bytes.length, verified.hash)] };
    });
    if (result.state === 'applied') await access.recordActivity();
    return { path: targetPath, converted };
  }

  public async remove(input: FileActionInput & { readonly expectedHash: string }): Promise<void> {
    validateHash(input.expectedHash);
    const filePath = normalizePath(input.path);
    const access = await this.access.authorizeMutation(input);
    const prior = await this.readPrior(access.scope, filePath);
    assertExpectedFile(input.expectedHash, prior);
    if (!prior) throw missingFile();
    const command = createCommand(access, filePath, prior, null);
    const result = await this.storageMutations.execute(command, access.resolveTrustedScope, async (trusted) => {
      const scope = trustedProjectScope(trusted, access);
      try {
        await this.gateway.remove(scope, { path: filePath, expectedHash: input.expectedHash });
      } catch (error: unknown) {
        if (isKnownNoSideEffect(error)) throw new StorageQuotaNoSideEffectError(error);
        throw error;
      }
      try {
        await this.gateway.download(scope, filePath);
      } catch (error: unknown) {
        if (isNotFound(error)) {
          return { result: undefined, changes: [verifiedChange(command.changes[0], null, null)] };
        }
        throw error;
      }
      throw new Error('The removed file is still present.');
    });
    if (result.state === 'applied') await access.recordActivity();
  }

  private async readPrior(scope: ProjectFileMutationAccess['scope'], filePath: string): Promise<ExistingFile | null> {
    try {
      return await this.gateway.download(scope, filePath);
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}

function createCommand(
  access: ProjectFileMutationAccess,
  filePath: string,
  prior: ExistingFile | null,
  next: Buffer | null
): StorageFileOperationCommand {
  const change: StorageFileReferencePlan = {
    kind: 'project_file',
    resourceKey: access.rootKey,
    copyKey: filePath,
    projectId: access.projectId,
    rootKey: access.rootKey,
    relativeKey: filePath,
    expectedPriorBytes: prior ? BigInt(prior.bytes.length) : null,
    expectedPriorSha256: prior?.hash ?? null,
    intendedBytes: next ? BigInt(next.length) : null,
    intendedSha256: next ? hash(next) : null
  };
  const identity = {
    ownerId: access.ownerId,
    operationKey: `manual-file:${randomUUID()}`,
    projectId: access.projectId,
    rootKey: access.rootKey,
    targetKey: filePath,
    changes: [change]
  };
  return { ...identity, fingerprint: storageFileOperationFingerprint(identity) };
}

function trustedProjectScope(trusted: StorageTrustedFileScope, access: ProjectFileMutationAccess): ProjectFileMutationAccess['scope'] {
  const root = trusted.roots.find((item) => item.rootKey === access.rootKey);
  if (trusted.ownerId !== access.ownerId || trusted.projectId !== access.projectId || trusted.roots.length !== 1 || !root
    || root.ownerId !== access.scope.ownerId || root.projectId !== access.scope.projectId
    || root.locatorProjectId !== access.scope.projectId || root.storageKind !== access.scope.storageKind
    || root.relativeRoot !== access.scope.relativeRoot) {
    throw new AppError('STORAGE_ACCOUNTING_UNAVAILABLE', 503, 'The trusted storage scope is unavailable.');
  }
  return access.scope;
}

function verifiedChange(plan: StorageFileReferencePlan | undefined, bytes: number | null, sha256: string | null): StorageVerifiedFileChange {
  if (!plan) throw new Error('The file operation has no target reference.');
  return {
    kind: plan.kind,
    resourceKey: plan.resourceKey,
    copyKey: plan.copyKey,
    projectId: plan.projectId,
    rootKey: plan.rootKey,
    relativeKey: plan.relativeKey,
    bytes: bytes === null ? null : BigInt(bytes),
    sha256
  };
}

function assertExpectedFile(expectedHash: string | null, prior: ExistingFile | null): void {
  if (expectedHash === null ? prior !== null : prior === null || prior.hash !== expectedHash) {
    throw new AppError(prior ? 'FILE_CONFLICT' : 'WORKSPACE_PATH_NOT_FOUND', prior ? 409 : 404,
      prior ? 'This file already exists or changed. Refresh it first.' : 'The requested file was not found.');
  }
}

function validatePayload(bytes: Buffer, maximumBytes: number): void {
  if (bytes.length > maximumBytes) throw new AppError('FILE_TOO_LARGE', 413, 'The file exceeds the allowed size.');
}

function normalizePath(filePath: string): string {
  return WorkspaceRelativePath.parse(filePath).value;
}

function extensionOf(filePath: string): string {
  const name = filePath.split('/').at(-1) ?? '';
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLocaleLowerCase('en-US');
}

function validateHash(value: string | null): void {
  if (value !== null && !/^[a-f0-9]{64}$/u.test(value)) throw new AppError('VALIDATION_ERROR', 400, 'Refresh the file before changing it.');
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function intendedHash(plan: StorageFileReferencePlan | undefined): string {
  if (!plan?.intendedSha256) throw new Error('The file operation has no intended hash.');
  return plan.intendedSha256;
}

function isNotFound(error: unknown): boolean {
  return hasCode(error, 'WORKSPACE_PATH_NOT_FOUND');
}

function isKnownNoSideEffect(error: unknown): boolean {
  if (hasCode(error, 'FILE_CONFLICT') || hasCode(error, 'WORKSPACE_PATH_NOT_FOUND')) return true;
  return error instanceof WorkspaceDomainError && [400, 403, 404].includes(error.statusCode);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function missingFile(): AppError {
  return new AppError('WORKSPACE_PATH_NOT_FOUND', 404, 'The requested file was not found.');
}
