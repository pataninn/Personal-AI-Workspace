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

export class LocalStagingGateway implements IStagingGateway {
  public constructor(private readonly options: LocalStagingGatewayOptions) {}

  public async stage(input: StageInput): Promise<StageResult> {
    const stagingReference = `run-${input.runId}`;
    const stagingDirectory = resolveStagingDirectory(this.options.stagingRoot, stagingReference);
    try {
      await fs.mkdir(stagingDirectory, { recursive: false });
      await fs.writeFile(path.join(stagingDirectory, 'request.txt'), redactEgressText(input.request), { encoding: 'utf8', flag: 'wx' });
      if (input.messages.length > 0) {
        await fs.writeFile(path.join(stagingDirectory, 'recent-messages.json'), JSON.stringify(input.messages.map(redactMessage)), { encoding: 'utf8', flag: 'wx' });
      }
      for (const file of input.files) {
        await this.copyFile(input, file.relativePath, file.sourceHash, file.sizeBytes, stagingDirectory);
      }
      return { stagingReference, itemCount: input.files.length + 1 + (input.messages.length > 0 ? 1 : 0) };
    } catch (error: unknown) {
      const cleaned = await this.tryCleanup(stagingReference);
      if (error instanceof AiRunStagingFailedError) {
        throw error;
      }
      throw new AiRunStagingFailedError(cleaned ? 'complete' : 'unknown');
    }
  }

  public async cleanup(stagingReference: string): Promise<void> {
    try {
      await fs.rm(resolveStagingDirectory(this.options.stagingRoot, stagingReference), { recursive: true, force: false });
    } catch {
      throw new AiRunStagingFailedError('unknown');
    }
  }

  private async copyFile(input: StageInput, relativePath: string, expectedHash: string, expectedSize: number, stagingReference: string): Promise<void> {
    const sourcePath = safeJoin(input.workspaceRoot, input.relativeRoot, relativePath);
    const destinationPath = safeJoin(stagingReference, relativePath);
    const sourceStats = await fs.lstat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      throw new Error('The selected source is not a regular file.');
    }
    if (expectedSize < 0 || expectedSize > MAX_STAGED_FILE_BYTES || sourceStats.size > expectedSize) {
      throw new Error('The selected source is larger than the staging limit.');
    }
    const content = redactEgressText(decodeStagedUtf8(await readBounded(sourcePath, expectedSize)));
    const actualHash = createHash('sha256').update(content, 'utf8').digest('hex');
    if (actualHash !== expectedHash) {
      throw new Error('The selected source changed before staging.');
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, content, { flag: 'wx' });
  }

  private async tryCleanup(stagingReference: string): Promise<boolean> {
    try {
      await fs.rm(resolveStagingDirectory(this.options.stagingRoot, stagingReference), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

function redactMessage(message: EgressMessage): EgressMessage {
  return { role: message.role, content: redactEgressText(message.content) };
}

async function readBounded(filePath: string, expectedSize: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(expectedSize + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    if (offset > expectedSize) {
      throw new Error('The selected source changed beyond the approved size.');
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function safeJoin(...segments: readonly string[]): string {
  const root = path.resolve(segments[0] ?? '.');
  const target = path.resolve(root, ...segments.slice(1));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Staging path escapes its configured root.');
  }
  return target;
}

function resolveStagingDirectory(stagingRoot: string, stagingReference: string): string {
  if (!/^run-[A-Za-z0-9-]+$/u.test(stagingReference)) {
    throw new Error('The staging reference is invalid.');
  }
  return safeJoin(stagingRoot, stagingReference);
}

function decodeStagedUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('The selected source is not valid UTF-8 text.');
  }
}
