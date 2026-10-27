import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { IWorkspaceExportArtifactStore } from '@/modules/workspace-exports/repositories/workspace-export-repository';
import { AppError } from '@/shared/errors/app-error';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** Stores export bytes under one private, server-derived directory in the local container. */
export class PrivateWorkspaceExportArtifactStore implements IWorkspaceExportArtifactStore {
  public constructor(private readonly temporaryDirectory = os.tmpdir()) {}

  public async write(id: string, bytes: Buffer): Promise<void> {
    assertId(id);
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw tooLarge();
    const directory = await this.ensureDirectory();
    const partPath = path.join(directory, `${id}.part`);
    const finalPath = path.join(directory, `${id}.json`);
    const handle = await fs.open(partPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await fs.lstat(finalPath).then(() => { throw new Error('Export target already exists.'); }, (error: unknown) => {
        if (!hasCode(error, 'ENOENT')) throw error;
      });
      await fs.rename(partPath, finalPath);
      const directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch (error: unknown) {
      await this.remove(id).catch(() => undefined);
      throw error;
    }
  }

  public async read(id: string): Promise<Buffer> {
    assertId(id);
    const target = path.join(await this.ensureDirectory(), `${id}.json`);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_DOCUMENT_BYTES)) throw unavailable();
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (!sameFile(before, after) || BigInt(bytes.byteLength) !== before.size) throw unavailable();
      return bytes;
    } finally { await handle.close(); }
  }

  public async exists(id: string): Promise<boolean> {
    assertId(id);
    try {
      const info = await fs.lstat(path.join(await this.ensureDirectory(), `${id}.json`));
      return info.isFile() && !info.isSymbolicLink() && info.size <= MAX_DOCUMENT_BYTES;
    } catch (error: unknown) {
      if (hasCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  public async remove(id: string): Promise<void> {
    assertId(id);
    const directory = await this.ensureDirectory();
    await Promise.all([`${id}.part`, `${id}.json`].map(async (name) => {
      try { await fs.unlink(path.join(directory, name)); }
      catch (error: unknown) { if (!hasCode(error, 'ENOENT')) throw error; }
    }));
  }

  public async listPartIds(): Promise<readonly string[]> {
    const names = await fs.readdir(await this.ensureDirectory());
    return names.flatMap((name) => {
      const match = /^([0-9a-f-]{36})\.part$/iu.exec(name);
      return match && UUID_PATTERN.test(match[1] ?? '') ? [match[1]!] : [];
    });
  }

  private async ensureDirectory(): Promise<string> {
    if (process.platform !== 'linux' || typeof process.getuid !== 'function') throw unavailable();
    const temporaryRoot = await fs.realpath(this.temporaryDirectory);
    const directory = path.join(temporaryRoot, 'workspace-exports');
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error: unknown) { if (!hasCode(error, 'EEXIST')) throw error; }
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw unavailable();
    if (await fs.realpath(directory) !== directory) throw unavailable();
    return directory;
  }
}

function assertId(id: string): void {
  if (!UUID_PATTERN.test(id)) throw unavailable();
}

function sameFile(left: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint }, right: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function tooLarge(): AppError { return new AppError('EXPORT_TOO_LARGE', 413, 'The workspace export exceeds its safe limits.'); }
function unavailable(): AppError { return new AppError('WORKSPACE_EXPORT_UNAVAILABLE', 404, 'The workspace export is unavailable.'); }
