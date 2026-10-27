import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { ExportWorkspaceFile } from '@/modules/files/repositories/project-file-access';
import { isProtectedSegment, WorkspaceRelativePath } from '@/modules/files/domain/workspace-path';
import { isProtectedFileName } from '@/modules/files/domain/workspace-policy';
import { isContained, joinWorkspaceFileSystemPath } from '@/infrastructure/workspace/workspace-gateway-paths';
import { AppError } from '@/shared/errors/app-error';
import { containsPotentialSecret } from '@/shared/egress/redaction';

const MAX_BYTES = 8 * 1024 * 1024;

export interface ExportCaptureTestFileHandle {
  stat(): Promise<CaptureStats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
  close(): Promise<void>;
}

export interface ExportCaptureTestFileSystem {
  lstat(filePath: string): Promise<CaptureStats>;
  realpath(filePath: string): Promise<string>;
  readDirectory(directoryPath: string): Promise<readonly string[]>;
  openRead(filePath: string): Promise<ExportCaptureTestFileHandle>;
}

interface CaptureStats {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isReparsePoint?(): boolean;
}

type CaptureOptions = { readonly maxFiles: number; readonly maxTotalBytes: number; readonly deadlineAt: number };

/** Uses pinned directory descriptors for the deployed Linux capture path. */
export async function capturePinnedDirectory(
  directory: FileHandle,
  options: CaptureOptions
): Promise<readonly ExportWorkspaceFile[]> {
  return captureDirectory(directory, '', options);
}

/** Portable path walker used only by direct temporary-directory boundary tests. */
export async function captureWithTestFileSystem(
  root: string,
  options: CaptureOptions,
  fileSystem: ExportCaptureTestFileSystem
): Promise<readonly ExportWorkspaceFile[]> {
  const canonicalRoot = normalizePath(await fileSystem.realpath(root));
  return capturePortableDirectory(canonicalRoot, canonicalRoot, '', options, fileSystem);
}

async function captureDirectory(
  directory: FileHandle,
  relative: string,
  options: CaptureOptions,
  files: ExportWorkspaceFile[] = [],
  seen: Set<string> = new Set(),
  counters: { entries: number; bytes: number } = { entries: 0, bytes: 0 }
): Promise<ExportWorkspaceFile[]> {
  assertExportDeadline(options.deadlineAt);
  const anchor = `/proc/self/fd/${directory.fd}`;
  const before = await directory.stat({ bigint: true });
  const names = await fs.readdir(anchor, { encoding: 'buffer' });
  for (const rawName of names) {
    assertExportDeadline(options.deadlineAt);
    counters.entries += 1;
    if (counters.entries > 10_000) throw exportTooLarge();
    const name = decodeName(rawName);
    const absolute = path.posix.join(anchor, name);
    const stats = await fs.lstat(absolute, { bigint: true });
    if (stats.isSymbolicLink()) throw exportIoError();
    if (isProtectedSegment(name)) continue;
    const normalizedPath = WorkspaceRelativePath.parse(relative.length === 0 ? name : `${relative}/${name}`).value;
    if (stats.isDirectory()) {
      const child = await fs.open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        assertSameObject(stats, await child.stat({ bigint: true }));
        await captureDirectory(child, normalizedPath, options, files, seen, counters);
      } finally { await child.close(); }
      continue;
    }
    if (!stats.isFile()) throw exportIoError();
    if (isProtectedFileName(normalizedPath)) continue;
    const captured = await readPinnedFile(absolute, normalizedPath, stats, options.deadlineAt);
    addCapturedFile(captured, files, seen, counters, options);
  }
  assertSameObject(before, await directory.stat({ bigint: true }));
  assertExportDeadline(options.deadlineAt);
  return files;
}

async function capturePortableDirectory(
  root: string,
  directory: string,
  relative: string,
  options: CaptureOptions,
  fileSystem: ExportCaptureTestFileSystem,
  files: ExportWorkspaceFile[] = [],
  seen: Set<string> = new Set(),
  counters: { entries: number; bytes: number } = { entries: 0, bytes: 0 }
): Promise<ExportWorkspaceFile[]> {
  assertExportDeadline(options.deadlineAt);
  const before = await fileSystem.lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink() || before.isReparsePoint?.()) throw exportIoError();
  assertContainedRealPath(root, directory, await fileSystem.realpath(directory));
  const names = await fileSystem.readDirectory(directory);
  for (const name of names) {
    assertExportDeadline(options.deadlineAt);
    counters.entries += 1;
    if (counters.entries > 10_000) throw exportTooLarge();
    if (name.includes('/') || name.includes('\\') || name.length === 0) throw exportIoError();
    const target = joinWorkspaceFileSystemPath(directory, name);
    const stats = await fileSystem.lstat(target);
    if (stats.isSymbolicLink() || stats.isReparsePoint?.()) throw exportIoError();
    if (isProtectedSegment(name)) continue;
    const normalizedPath = WorkspaceRelativePath.parse(relative.length === 0 ? name : `${relative}/${name}`).value;
    assertContainedRealPath(root, target, await fileSystem.realpath(target));
    if (stats.isDirectory()) {
      await capturePortableDirectory(root, target, normalizedPath, options, fileSystem, files, seen, counters);
      continue;
    }
    if (!stats.isFile()) throw exportIoError();
    if (isProtectedFileName(normalizedPath)) continue;
    addCapturedFile(await readPortableFile(target, normalizedPath, stats, options.deadlineAt, fileSystem), files, seen, counters, options);
  }
  assertSameObject(before, await fileSystem.lstat(directory));
  assertExportDeadline(options.deadlineAt);
  return files;
}

async function readPinnedFile(
  target: string,
  relativePath: string,
  found: BigIntStats,
  deadlineAt: number
): Promise<ExportWorkspaceFile> {
  if (found.size > BigInt(MAX_BYTES)) throw exportTooLarge();
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assertSameObject(found, before);
    return await readOpenedFile(
      (buffer, offset, length, position) => handle.read(buffer, offset, length, position).then((result) => result.bytesRead),
      () => handle.stat({ bigint: true }), before, relativePath, deadlineAt
    );
  } finally { await handle.close(); }
}

async function readPortableFile(
  target: string,
  relativePath: string,
  found: CaptureStats,
  deadlineAt: number,
  fileSystem: ExportCaptureTestFileSystem
): Promise<ExportWorkspaceFile> {
  if (found.size > BigInt(MAX_BYTES)) throw exportTooLarge();
  const handle = await fileSystem.openRead(target);
  try {
    const before = await handle.stat();
    assertSameObject(found, before);
    return await readOpenedFile(
      (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      () => handle.stat(), before, relativePath, deadlineAt
    );
  } finally { await handle.close(); }
}

async function readOpenedFile(
  read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<number>,
  stat: () => Promise<CaptureStats>,
  before: CaptureStats,
  relativePath: string,
  deadlineAt: number
): Promise<ExportWorkspaceFile> {
  if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw exportTooLarge();
  const sizeBytes = Number(before.size);
  const bytes = Buffer.alloc(sizeBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    assertExportDeadline(deadlineAt);
    const count = await read(bytes, offset, bytes.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== sizeBytes) throw exportIoError();
  const after = await stat();
  assertSameObject(before, after);
  if (containsPotentialSecret(bytes.toString('utf8'))) throw exportContentUnsafe();
  const content = bytes.subarray(0, sizeBytes);
  return { path: relativePath, encoding: 'base64', sizeBytes, sha256: hash(content), content: content.toString('base64') };
}

function addCapturedFile(
  captured: ExportWorkspaceFile,
  files: ExportWorkspaceFile[],
  seen: Set<string>,
  counters: { entries: number; bytes: number },
  options: CaptureOptions
): void {
  if (seen.has(captured.path)) throw exportIoError();
  if (files.length >= options.maxFiles || counters.bytes + captured.sizeBytes > options.maxTotalBytes) throw exportTooLarge();
  seen.add(captured.path);
  counters.bytes += captured.sizeBytes;
  files.push(captured);
}

function assertContainedRealPath(root: string, target: string, realPath: string): void {
  const normalizedTarget = normalizePath(target);
  const normalizedRealPath = normalizePath(realPath);
  if (normalizedTarget !== normalizedRealPath || !isContained(root, normalizedRealPath, true)) throw exportIoError();
}

function assertSameObject(left: CaptureStats, right: CaptureStats): void {
  if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size || left.mtimeNs !== right.mtimeNs || left.ctimeNs !== right.ctimeNs) throw exportIoError();
}

function decodeName(value: Buffer): string {
  const name = value.toString('utf8');
  if (!Buffer.from(name, 'utf8').equals(value) || name.length === 0 || name.includes('/') || name.includes('\\')) throw exportIoError();
  return name;
}

function normalizePath(value: string): string { return value.replaceAll('\\', '/'); }
function assertExportDeadline(deadlineAt: number): void { if (Date.now() >= deadlineAt) throw exportTooLarge(); }
function exportTooLarge(): AppError { return new AppError('EXPORT_TOO_LARGE', 413, 'The workspace export exceeds its safe limits.'); }
function exportIoError(): AppError { return new AppError('EXPORT_FAILED', 500, 'The workspace export could not be prepared.'); }
function exportContentUnsafe(): AppError { return new AppError('EXPORT_CONTENT_UNSAFE', 422, 'Workspace content contains text that looks like a credential. Remove it before exporting.'); }
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
