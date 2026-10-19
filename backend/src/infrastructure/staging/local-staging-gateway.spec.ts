import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LocalStagingGateway } from '@/infrastructure/staging/local-staging-gateway';
import { AiRunStagingFailedError } from '@/modules/ai-runs/domain/ai-run-errors';
import type { StageInput } from '@/modules/ai-runs/repositories/staging-gateway';

const RUN_1 = '11111111-1111-4111-8111-111111111111';
const RUN_2 = '22222222-2222-4222-8222-222222222222';
const RUN_3 = '33333333-3333-4333-8333-333333333333';
const RUN_4 = '44444444-4444-4444-8444-444444444444';
const RUN_5 = '55555555-5555-4555-8555-555555555555';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RUN_BYTES = 2 * 1024 * 1024;
const TTL_MS = 24 * 60 * 60 * 1_000;

describe('LocalStagingGateway', () => {
  let workspaceRoot: string;
  let stagingRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'pai-workspace-'));
    stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'pai-staging-'));
    await writeFile(path.join(workspaceRoot, 'project.ts'), 'const answer = 42;\n', 'utf8');
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(stagingRoot, { recursive: true, force: true });
  });

  it('copies only approved redacted files and writes a durable 24-hour marker', async () => {
    const content = 'const answer = 42;\n';
    const gateway = new LocalStagingGateway({ stagingRoot });
    const result = await gateway.stage({
      runId: RUN_1,
      request: 'Inspect',
      files: [{ relativePath: 'project.ts', sourceHash: createHash('sha256').update(content).digest('hex'), sizeBytes: Buffer.byteLength(content), content }],
      messages: []
    });

    expect(result.stagingReference).toBe(`run-${RUN_1}`);
    expect(await readFile(path.join(stagingRoot, result.stagingReference, 'project.ts'), 'utf8')).toBe(content);
    expect(await readFile(path.join(stagingRoot, result.stagingReference, 'request.txt'), 'utf8')).toBe('Inspect');
    const marker = JSON.parse(await readFile(path.join(stagingRoot, result.stagingReference, '.staging-metadata.json'), 'utf8')) as { createdAt: string; expiresAt: string; runId: string; version: number; checksum: string };
    expect(marker).toMatchObject({ version: 1, runId: RUN_1 });
    expect(Date.parse(marker.expiresAt) - Date.parse(marker.createdAt)).toBe(TTL_MS);
    await expect(gateway.assertFresh(result.stagingReference)).resolves.toBeUndefined();
    await gateway.cleanup(result.stagingReference);
  });

  it('rejects a per-file overflow before publishing a staging directory', async () => {
    const gateway = new LocalStagingGateway({ stagingRoot });
    await expect(gateway.stage({
      runId: RUN_2,
      request: 'Inspect',
      files: [{ relativePath: 'project.ts', sourceHash: '0'.repeat(64), sizeBytes: 1, content: 'x'.repeat(MAX_FILE_BYTES + 1) }],
      messages: []
    })).rejects.toBeInstanceOf(AiRunStagingFailedError);
    await expect(stat(path.join(stagingRoot, `run-${RUN_2}`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies the per-file cap to the redacted request and serialized messages too', async () => {
    const gateway = new LocalStagingGateway({ stagingRoot });
    await expect(gateway.stage({ runId: RUN_1, request: 'x'.repeat(MAX_FILE_BYTES + 1), files: [], messages: [] }))
      .rejects.toBeInstanceOf(AiRunStagingFailedError);
    await expect(gateway.stage({ runId: RUN_2, request: 'Inspect', files: [], messages: [{ role: 'user', content: 'x'.repeat(MAX_FILE_BYTES - 10) }] }))
      .rejects.toBeInstanceOf(AiRunStagingFailedError);
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  it('enforces the exact aggregate redacted footprint before creating the run directory', async () => {
    const gateway = new LocalStagingGateway({ stagingRoot });
    const files = Array.from({ length: 8 }, (_, index) => ({
      relativePath: `file-${index}.txt`,
      sourceHash: '0'.repeat(64),
      sizeBytes: MAX_FILE_BYTES,
      content: 'x'.repeat(MAX_FILE_BYTES)
    }));
    await expect(gateway.stage({ runId: RUN_3, request: 'Inspect', files, messages: [] })).rejects.toBeInstanceOf(AiRunStagingFailedError);
    await expect(stat(path.join(stagingRoot, `run-${RUN_3}`))).rejects.toMatchObject({ code: 'ENOENT' });

    const validFiles = files.slice(0, 7);
    const valid = await gateway.stage({ runId: RUN_4, request: 'Inspect', files: validFiles, messages: [] });
    const staged = await readDirectoryBytes(path.join(stagingRoot, valid.stagingReference));
    expect(staged).toBeLessThanOrEqual(MAX_RUN_BYTES);
    await gateway.cleanup(valid.stagingReference);
  });

  it('rejects traversal and non-canonical relative-path aliases', async () => {
    const gateway = new LocalStagingGateway({ stagingRoot });
    for (const relativePath of ['../outside.txt', 'nested/../outside.txt', 'nested\\outside.txt']) {
      await expect(gateway.stage({
        runId: RUN_5,
        request: 'Inspect',
        files: [{ relativePath, sourceHash: '0'.repeat(64), sizeBytes: 1, content: 'x' }],
        messages: []
      })).rejects.toBeInstanceOf(AiRunStagingFailedError);
    }
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  it('redacts secret-like file and message values before writing the staged snapshot', async () => {
    const raw = "const apiKey = 'secret-value-123';\n";
    const redacted = "const apiKey = '[REDACTED]';\n";
    const gateway = new LocalStagingGateway({ stagingRoot });
    const result = await gateway.stage({
      runId: RUN_5,
      request: 'token=request-secret-123',
      files: [{ relativePath: 'config.ts', sourceHash: createHash('sha256').update(redacted).digest('hex'), sizeBytes: Buffer.byteLength(raw), content: raw }],
      messages: [{ role: 'user', content: 'token=message-secret-123' }]
    });

    expect(await readFile(path.join(stagingRoot, result.stagingReference, 'config.ts'), 'utf8')).toBe(redacted);
    expect(await readFile(path.join(stagingRoot, result.stagingReference, 'recent-messages.json'), 'utf8')).toContain('[REDACTED]');
    expect(await readFile(path.join(stagingRoot, result.stagingReference, 'request.txt'), 'utf8')).toContain('[REDACTED]');
    expect(await readFile(path.join(stagingRoot, result.stagingReference, 'config.ts'), 'utf8')).not.toContain('secret-value-123');
    await gateway.cleanup(result.stagingReference);
  });

  it('removes an expired, intact staging directory and leaves a tampered marker untouched', async () => {
    const gateway = new LocalStagingGateway({ stagingRoot });
    const expired = await gateway.stage({ runId: RUN_1, request: 'Inspect', files: [], messages: [] });
    await rewriteMarkerAsExpired(path.join(stagingRoot, expired.stagingReference, '.staging-metadata.json'), RUN_1);
    await expect(gateway.assertFresh(expired.stagingReference)).rejects.toMatchObject({ cleanup: 'complete' });
    await expect(gateway.cleanupExpired()).resolves.toBe(1);
    await expect(stat(path.join(stagingRoot, expired.stagingReference))).rejects.toMatchObject({ code: 'ENOENT' });

    const tampered = await gateway.stage({ runId: RUN_2, request: 'Inspect', files: [], messages: [] });
    const markerPath = path.join(stagingRoot, tampered.stagingReference, '.staging-metadata.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, string | number>;
    marker.createdAt = new Date(Date.now() - TTL_MS - 5_000).toISOString();
    marker.expiresAt = new Date(Date.now() - 5_000).toISOString();
    await writeFile(markerPath, JSON.stringify(marker), 'utf8');
    await expect(gateway.cleanupExpired()).resolves.toBe(0);
    await expect(stat(path.join(stagingRoot, tampered.stagingReference))).resolves.toBeDefined();
  });

  it('shares an in-flight sweep and never removes outside staging through a directory symlink', async () => {
    const gateway = new LocalStagingGateway({ stagingRoot });
    const staged = await gateway.stage({ runId: RUN_1, request: 'Inspect', files: [], messages: [] });
    await rewriteMarkerAsExpired(path.join(stagingRoot, staged.stagingReference, '.staging-metadata.json'), RUN_1);
    const [first, second] = await Promise.all([gateway.cleanupExpired(), gateway.cleanupExpired()]);
    expect(first).toBe(1);
    expect(second).toBe(1);

    const outside = await mkdtemp(path.join(os.tmpdir(), 'pai-outside-'));
    try {
      await writeFile(path.join(outside, 'keep.txt'), 'keep', 'utf8');
      try {
        await symlink(outside, path.join(stagingRoot, `run-${RUN_2}`), 'junction');
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))) return;
        throw error;
      }
      await expect(gateway.cleanupExpired()).resolves.toBe(0);
      await expect(readFile(path.join(outside, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

async function rewriteMarkerAsExpired(markerPath: string, runId: string): Promise<void> {
  const createdAt = new Date(Date.now() - TTL_MS - 5_000).toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + TTL_MS).toISOString();
  const payload = { version: 1, runId, createdAt, expiresAt };
  const checksum = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  await writeFile(markerPath, JSON.stringify({ ...payload, checksum }), 'utf8');
}

async function readDirectoryBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  let totalBytes = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      totalBytes += await readDirectoryBytes(entryPath);
    } else {
      totalBytes += (await stat(entryPath)).size;
    }
  }
  return totalBytes;
}
