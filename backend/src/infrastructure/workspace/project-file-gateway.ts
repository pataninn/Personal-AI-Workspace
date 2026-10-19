import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { IProjectFileGateway } from '@/modules/files/repositories/project-file-access';
import type { WorkspaceProjectScope } from '@/modules/files/domain/workspace-types';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import { WorkspaceRelativePath } from '@/modules/files/domain/workspace-path';
import { isProtectedFileName } from '@/modules/files/domain/workspace-policy';
import { WorkspacePathForbiddenError } from '@/modules/files/domain/workspace-errors';
import { defaultWorkspaceGatewayFileSystem } from '@/infrastructure/workspace/workspace-gateway-fs';
import { assertDirectory, isContained, resolveWorkspaceEntry, resolveWorkspaceScope } from '@/infrastructure/workspace/workspace-gateway-paths';
import { WorkspaceOperationContext } from '@/infrastructure/workspace/workspace-operation';
import { AppError } from '@/shared/errors/app-error';

const MAX_BYTES = 8 * 1024 * 1024;
const fileSystem = { ...defaultWorkspaceGatewayFileSystem, realpath: async (value: string): Promise<string> => (await fs.realpath(value)).replaceAll('\\', '/') };

/** Bounded binary/text operations with safe paths, exclusive creation and hash claims. */
export class ProjectFileGateway implements IProjectFileGateway {
  public constructor(private readonly options: { readonly containerRoot: string; readonly workspaceBoundary: IWorkspaceBoundary }) {}

  /** Creates only validated parent directories beneath the already-resolved trusted project root. */
  public async ensureParentDirectories(scope: WorkspaceProjectScope, relativePath: string): Promise<void> {
    const parsed = WorkspaceRelativePath.parse(relativePath).value;
    const context = new WorkspaceOperationContext(undefined, 5000);
    const paths = await resolveWorkspaceScope(this.options.workspaceBoundary, fileSystem, this.options.containerRoot.replaceAll('\\', '/'), scope, context);
    const segments = path.posix.dirname(parsed).split('/').filter((segment) => segment !== '.');
    let current = paths.canonicalProjectRoot;
    for (const segment of segments) {
      current = path.posix.join(current, segment);
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error: unknown) {
        if (!hasCode(error, 'EEXIST')) throw error;
      }
      const stats = await fs.lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new WorkspacePathForbiddenError();
      const real = (await fs.realpath(current)).replaceAll('\\', '/');
      if (real !== current || !isContained(paths.canonicalProjectRoot, real, true)) throw new WorkspacePathForbiddenError();
    }
  }

  public async download(scope: WorkspaceProjectScope, relativePath: string): Promise<{ readonly bytes: Buffer; readonly hash: string }> {
    return this.withTarget(scope, relativePath, async (target) => {
      const bytes = await this.read(target).catch(mapReadError);
      return { bytes, hash: hash(bytes) };
    });
  }

  public async write(scope: WorkspaceProjectScope, input: { readonly path: string; readonly bytes: Buffer; readonly expectedHash: string | null }): Promise<{ readonly hash: string }> {
    return this.withTarget(scope, input.path, (target) => this.writeTarget(target, input));
  }

  private async writeTarget(target: string, input: { readonly bytes: Buffer; readonly expectedHash: string | null }): Promise<{ readonly hash: string }> {
    let claim: string | null = null;
    if (input.expectedHash !== null) claim = await this.claim(target, input.expectedHash);
    try {
      const mode = claim ? (await fs.stat(claim)).mode & 0o777 : 0o600;
      await this.writeExclusive(target, input.bytes, mode);
    } catch (error: unknown) {
      if (claim) await this.restore(target, claim);
      if (hasCode(error, 'EEXIST')) throw new AppError('FILE_CONFLICT', 409, 'This file already exists or changed. Refresh it first.');
      throw error;
    }
    if (claim) await fs.unlink(claim);
    return { hash: hash(input.bytes) };
  }

  public async remove(scope: WorkspaceProjectScope, input: { readonly path: string; readonly expectedHash: string }): Promise<void> {
    return this.withTarget(scope, input.path, async (target) => {
      const claim = await this.claim(target, input.expectedHash);
      try { await fs.unlink(claim); } catch (error: unknown) { await this.restore(target, claim); throw error; }
    });
  }

  private async withTarget<T>(scope: WorkspaceProjectScope, relativePath: string, action: (target: string) => Promise<T>): Promise<T> {
    const resolved = await this.resolve(scope, relativePath);
    const parent = path.posix.dirname(resolved.target);
    if (process.platform !== 'linux') {
      if ((await fs.realpath(parent)).replaceAll('\\', '/') !== parent) throw new WorkspacePathForbiddenError();
      return action(resolved.target);
    }
    // The deployed Linux container pins the directory inode, so later parent symlink swaps cannot redirect operations.
    const handle = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const anchor = `/proc/self/fd/${handle.fd}`;
      const pinnedParent = await fs.realpath(anchor);
      if (pinnedParent !== parent || !isContained(resolved.root, pinnedParent, true)) throw new WorkspacePathForbiddenError();
      return await action(path.posix.join(anchor, path.posix.basename(resolved.target)));
    } finally { await handle.close(); }
  }

  private async resolve(scope: WorkspaceProjectScope, relativePath: string): Promise<{ readonly target: string; readonly root: string }> {
    const parsed = WorkspaceRelativePath.parse(relativePath).value;
    if (isProtectedFileName(parsed)) throw new WorkspacePathForbiddenError();
    const context = new WorkspaceOperationContext(undefined, 5000);
    const paths = await resolveWorkspaceScope(this.options.workspaceBoundary, fileSystem, this.options.containerRoot.replaceAll('\\', '/'), scope, context);
    const directory = path.posix.dirname(parsed);
    const parent = await resolveWorkspaceEntry(fileSystem, paths, directory === '.' ? '' : directory, context);
    assertDirectory(parent.stats);
    const target = path.posix.join(paths.canonicalProjectRoot, parsed);
    try {
      const existing = await resolveWorkspaceEntry(fileSystem, paths, parsed, context);
      if (!existing.stats.isFile()) throw new WorkspacePathForbiddenError();
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'WORKSPACE_PATH_NOT_FOUND')) throw error;
    }
    return { target, root: paths.canonicalProjectRoot };
  }

  private async read(target: string): Promise<Buffer> {
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new WorkspacePathForbiddenError();
      if (stats.size > MAX_BYTES) throw new AppError('FILE_TOO_LARGE', 413, 'Files must be 8 MB or smaller.');
      const bytes = Buffer.alloc(stats.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > stats.size) throw new AppError('FILE_CONFLICT', 409, 'The file changed while reading. Refresh it.');
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }

  private async writeExclusive(target: string, bytes: Buffer, mode: number): Promise<void> {
    const handle = await fs.open(target, 'wx', mode);
    const ownStats = await handle.stat();
    try { await handle.chmod(mode); await handle.writeFile(bytes); await handle.sync(); }
    catch (error: unknown) {
      const current = await fs.lstat(target).catch(() => null);
      if (current && current.ino === ownStats.ino && current.dev === ownStats.dev) await fs.unlink(target);
      throw error;
    } finally { await handle.close(); }
  }

  private async claim(target: string, expectedHash: string): Promise<string> {
    const original = await this.read(target).catch(mapReadError);
    if (hash(original) !== expectedHash) throw new AppError('FILE_CONFLICT', 409, 'The file changed. Refresh before saving or deleting.');
    const claim = path.posix.join(path.posix.dirname(target), `.personal-ai-file-${randomUUID()}`);
    await fs.rename(target, claim);
    try {
      if (hash(await this.read(claim)) !== expectedHash) throw new AppError('FILE_CONFLICT', 409, 'The file changed. Refresh it.');
    } catch (error: unknown) { await this.restore(target, claim); throw error; }
    return claim;
  }

  private async restore(target: string, claim: string): Promise<void> {
    // link is exclusive: a concurrent external file is never overwritten during rollback.
    try { await fs.link(claim, target); await fs.unlink(claim); }
    catch { throw new AppError('FILE_RECOVERY_REQUIRED', 409, 'File recovery is needed. Your original content was preserved in a private temporary file.'); }
  }
}

function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function hasCode(value: unknown, code: string): boolean { return typeof value === 'object' && value !== null && 'code' in value && value.code === code; }

function mapReadError(error: unknown): never {
  if (hasCode(error, 'ENOENT')) throw new AppError('WORKSPACE_PATH_NOT_FOUND', 404, 'The requested file was not found.');
  throw error;
}
