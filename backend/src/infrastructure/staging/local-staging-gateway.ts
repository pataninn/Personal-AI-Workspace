import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { AiRunStagingFailedError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { EgressMessage } from '@/modules/ai-runs/domain/ai-run-types';
import type { IStagingGateway, StageInput, StageResult } from '@/modules/ai-runs/repositories/staging-gateway';
import { redactEgressText } from '@/shared/egress/redaction';

export interface LocalStagingGatewayOptions {
  readonly stagingRoot: string;
}

const MAX_STAGED_FILE_BYTES = 256 * 1024;
const MAX_STAGED_RUN_BYTES = 2 * 1024 * 1024;
const STAGING_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_SWEEP_CANDIDATES = 128;
const MARKER_NAME = '.staging-metadata.json';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface StagingMarkerPayload {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface StagingMarker extends StagingMarkerPayload {
  readonly checksum: string;
}

interface PlannedFile {
  readonly relativePath: string;
  readonly content: string;
}

interface StagingPlan {
  readonly runId: string;
  readonly files: readonly PlannedFile[];
  readonly marker: StagingMarker;
  readonly itemCount: number;
}

export class LocalStagingGateway implements IStagingGateway {
  private cleanupExpiredInFlight: Promise<number> | null = null;
  private lastSweepName = '';

  public constructor(private readonly options: LocalStagingGatewayOptions) {}

  public async stage(input: StageInput): Promise<StageResult> {
    const plan = createStagingPlan(input);
    let stagingDirectory: string;
    try {
      const stagingRoot = await this.resolveStagingRoot(true);
      stagingDirectory = resolveStagingDirectory(stagingRoot, `run-${plan.runId}`);
    } catch {
      throw new AiRunStagingFailedError('complete');
    }

    let directoryCreated = false;
    try {
      await fs.mkdir(stagingDirectory, { recursive: false });
      directoryCreated = true;
      await writeDurableMarker(stagingDirectory, plan.marker);
      for (const file of plan.files) {
        const destinationPath = safeJoin(stagingDirectory, ...file.relativePath.split('/'));
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.writeFile(destinationPath, file.content, { encoding: 'utf8', flag: 'wx' });
      }
      return { stagingReference: `run-${plan.runId}`, itemCount: plan.itemCount };
    } catch {
      const cleaned = directoryCreated ? await this.tryCleanup(stagingDirectory) : true;
      throw new AiRunStagingFailedError(cleaned ? 'complete' : 'unknown');
    }
  }

  public async assertFresh(stagingReference: string): Promise<void> {
    let runId: string;
    try {
      runId = runIdFromReference(stagingReference);
      const root = await this.resolveStagingRoot(false);
      const directory = resolveStagingDirectory(root, stagingReference);
      const marker = await readValidatedMarker(directory, runId);
      if (Date.parse(marker.expiresAt) <= Date.now()) {
        throw new AiRunStagingFailedError('complete');
      }
    } catch (error: unknown) {
      if (error instanceof AiRunStagingFailedError) throw error;
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      throw new AiRunStagingFailedError(code === 'ENOENT' ? 'complete' : 'unknown');
    }
  }

  public async cleanup(stagingReference: string): Promise<void> {
    const runId = runIdFromReference(stagingReference);
    try {
      const root = await this.resolveStagingRoot(false);
      const directory = resolveStagingDirectory(root, stagingReference);
      if (!(await exists(directory))) return;
      await readValidatedMarker(directory, runId);
      await fs.rm(directory, { recursive: true, force: false });
    } catch {
      throw new AiRunStagingFailedError('unknown');
    }
  }

  public cleanupExpired(): Promise<number> {
    if (this.cleanupExpiredInFlight) return this.cleanupExpiredInFlight;
    const current = this.sweepExpired();
    this.cleanupExpiredInFlight = current;
    void current.then(() => {
      if (this.cleanupExpiredInFlight === current) this.cleanupExpiredInFlight = null;
    }, () => {
      if (this.cleanupExpiredInFlight === current) this.cleanupExpiredInFlight = null;
    });
    return current;
  }

  private async sweepExpired(): Promise<number> {
    let root: string;
    try {
      root = await this.resolveStagingRoot(false);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
      throw new AiRunStagingFailedError('unknown');
    }

    let candidates: string[];
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      candidates = entries
        .filter((entry) => entry.isDirectory() && runIdFromDirectoryName(String(entry.name)) !== null)
        .map((entry) => String(entry.name))
        .sort();
    } catch {
      throw new AiRunStagingFailedError('unknown');
    }
    const remaining = candidates.filter((name) => name > this.lastSweepName);
    const page = (remaining.length > 0 ? remaining : candidates).slice(0, MAX_SWEEP_CANDIDATES);
    this.lastSweepName = page.at(-1) ?? '';

    let removed = 0;
    for (const name of page) {
      const runId = runIdFromDirectoryName(name);
      if (!runId) continue;
      const directory = resolveStagingDirectory(root, name);
      let marker: StagingMarker;
      try {
        marker = await readValidatedMarker(directory, runId);
      } catch {
        continue;
      }
      if (Date.parse(marker.expiresAt) > Date.now()) continue;
      try {
        await fs.rm(directory, { recursive: true, force: false });
        removed += 1;
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw new AiRunStagingFailedError('unknown');
      }
    }
    if (page.length === 0 || page.at(-1) === candidates.at(-1)) this.lastSweepName = '';
    return removed;
  }

  private async resolveStagingRoot(createIfMissing: boolean): Promise<string> {
    const configuredRoot = path.resolve(this.options.stagingRoot);
    if (createIfMissing) {
      await fs.mkdir(configuredRoot, { recursive: true });
    }
    const rootInfo = await fs.lstat(configuredRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error('The configured staging root is not a trusted directory.');
    }
    const canonicalRoot = await fs.realpath(configuredRoot);
    if (!samePath(configuredRoot, canonicalRoot)) {
      throw new Error('The configured staging root contains an alias.');
    }
    return canonicalRoot;
  }

  private async tryCleanup(stagingDirectory: string): Promise<boolean> {
    try {
      await fs.rm(stagingDirectory, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

function createStagingPlan(input: StageInput): StagingPlan {
  if (!isRunId(input.runId)) throw new AiRunStagingFailedError('complete');

  const files: PlannedFile[] = [];
  const request = redactEgressText(input.request);
  assertFileWithinLimit(request);
  files.push({ relativePath: 'request.txt', content: request });
  if (input.messages.length > 0) {
    const messages = JSON.stringify(input.messages.map(redactMessage));
    assertFileWithinLimit(messages);
    files.push({ relativePath: 'recent-messages.json', content: messages });
  }

  const seenPaths = new Set(files.map((file) => file.relativePath));
  for (const source of input.files) {
    validateRelativePath(source.relativePath);
    if (seenPaths.has(source.relativePath)) throw new AiRunStagingFailedError('complete');
    seenPaths.add(source.relativePath);
    const sourceBytes = Buffer.byteLength(source.content, 'utf8');
    if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0 || source.sizeBytes > MAX_STAGED_FILE_BYTES || sourceBytes > MAX_STAGED_FILE_BYTES || sourceBytes !== source.sizeBytes) {
      throw new AiRunStagingFailedError('complete');
    }
    const content = redactEgressText(source.content);
    assertFileWithinLimit(content);
    files.push({ relativePath: source.relativePath, content });
  }

  const createdAt = new Date();
  const payload: StagingMarkerPayload = {
    version: 1,
    runId: input.runId,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + STAGING_TTL_MS).toISOString()
  };
  const marker = { ...payload, checksum: markerChecksum(payload) };
  assertFileWithinLimit(JSON.stringify(marker));
  const totalBytes = files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0)
    + Buffer.byteLength(JSON.stringify(marker), 'utf8');
  if (totalBytes > MAX_STAGED_RUN_BYTES) throw new AiRunStagingFailedError('complete');

  return { runId: input.runId, files, marker, itemCount: input.files.length + 1 + (input.messages.length > 0 ? 1 : 0) };
}

function assertFileWithinLimit(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_STAGED_FILE_BYTES) throw new AiRunStagingFailedError('complete');
}

function redactMessage(message: EgressMessage): EgressMessage {
  return { role: redactEgressText(message.role), content: redactEgressText(message.content) };
}

function markerChecksum(payload: StagingMarkerPayload): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

async function writeDurableMarker(stagingDirectory: string, marker: StagingMarker): Promise<void> {
  const handle = await fs.open(path.join(stagingDirectory, MARKER_NAME), 'wx');
  try {
    await handle.writeFile(JSON.stringify(marker), { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readValidatedMarker(stagingDirectory: string, runId: string): Promise<StagingMarker> {
  const directoryInfo = await fs.lstat(stagingDirectory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error('The staged run directory is not a directory.');
  const canonicalDirectory = await fs.realpath(stagingDirectory);
  if (!samePath(stagingDirectory, canonicalDirectory)) throw new Error('The staged run directory contains an alias.');

  const markerPath = path.join(stagingDirectory, MARKER_NAME);
  const markerInfo = await fs.lstat(markerPath);
  if (markerInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.size > 4 * 1024) throw new Error('The staging marker is invalid.');
  const raw = await fs.readFile(markerPath, 'utf8');
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'checksum,createdAt,expiresAt,runId,version') {
    throw new Error('The staging marker is invalid.');
  }
  if (value.version !== 1 || value.runId !== runId || !isCanonicalDate(value.createdAt) || !isCanonicalDate(value.expiresAt)) {
    throw new Error('The staging marker is invalid.');
  }
  const createdAt = Date.parse(value.createdAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (expiresAt - createdAt !== STAGING_TTL_MS || expiresAt <= createdAt || !isSha256(value.checksum)) {
    throw new Error('The staging marker is invalid.');
  }
  const payload: StagingMarkerPayload = { version: 1, runId, createdAt: value.createdAt, expiresAt: value.expiresAt };
  if (markerChecksum(payload) !== value.checksum) throw new Error('The staging marker checksum is invalid.');
  return { ...payload, checksum: value.checksum };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function validateRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.includes('\\') || relativePath.includes(':') || relativePath.startsWith('/') || path.posix.isAbsolute(relativePath)) {
    throw new AiRunStagingFailedError('complete');
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new AiRunStagingFailedError('complete');
  if (segments.join('/') !== relativePath) throw new AiRunStagingFailedError('complete');
}

function safeJoin(rootPath: string, ...segments: readonly string[]): string {
  const root = path.resolve(rootPath);
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    if (relative === '') return target;
    throw new Error('Staging path escapes its configured root.');
  }
  return target;
}

function resolveStagingDirectory(stagingRoot: string, stagingReference: string): string {
  const runId = runIdFromReference(stagingReference);
  return safeJoin(stagingRoot, `run-${runId}`);
}

function runIdFromReference(stagingReference: string): string {
  if (!stagingReference.startsWith('run-')) throw new Error('The staging reference is invalid.');
  const runId = stagingReference.slice(4);
  if (!isRunId(runId) || stagingReference !== `run-${runId}`) throw new Error('The staging reference is invalid.');
  return runId;
}

function runIdFromDirectoryName(name: string): string | null {
  if (!name.startsWith('run-')) return null;
  const runId = name.slice(4);
  return isRunId(runId) && name === `run-${runId}` ? runId : null;
}

function isRunId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}
