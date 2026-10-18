import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LocalStagingGateway } from '@/infrastructure/staging/local-staging-gateway';
import { AiRunStagingFailedError } from '@/modules/ai-runs/domain/ai-run-errors';

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

  it('copies only the approved bounded files into a unique run area', async () => {
    const content = 'const answer = 42;\n';
    const gateway = new LocalStagingGateway({ stagingRoot });
    const result = await gateway.stage({
      runId: 'run-1',
      request: 'Inspect',
      files: [{ relativePath: 'project.ts', sourceHash: createHash('sha256').update(content).digest('hex'), sizeBytes: Buffer.byteLength(content), content }],
      messages: []
    });

    expect(result.stagingReference).toBe('run-run-1');
    expect(await readFile(path.join(stagingRoot, result.stagingReference, 'project.ts'), 'utf8')).toBe(content);
    expect(await readFile(path.join(stagingRoot, result.stagingReference, 'request.txt'), 'utf8')).toBe('Inspect');
    await gateway.cleanup(result.stagingReference);
  });

  it('fails and cleans up when staged content exceeds the safety limit', async () => {
    const gateway = new LocalStagingGateway({ stagingRoot });
    await expect(gateway.stage({
      runId: 'run-2',
      request: 'Inspect',
      files: [{ relativePath: 'project.ts', sourceHash: '0'.repeat(64), sizeBytes: 1, content: 'x'.repeat(256 * 1024 + 1) }],
      messages: []
    })).rejects.toBeInstanceOf(AiRunStagingFailedError);
    await expect(readFile(path.join(stagingRoot, 'run-run-2', 'request.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal without writing outside the staging root', async () => {
    const gateway = new LocalStagingGateway({ stagingRoot });
    await expect(gateway.stage({
      runId: 'run-3',
      request: 'Inspect',
      files: [{ relativePath: '../outside.txt', sourceHash: '0'.repeat(64), sizeBytes: 1, content: 'x' }],
      messages: []
    })).rejects.toBeInstanceOf(AiRunStagingFailedError);
  });

  it('redacts secret-like file and message values before writing the staged snapshot', async () => {
    const raw = "const apiKey = 'secret-value-123';\n";
    const redacted = "const apiKey = '[REDACTED]';\n";
    await writeFile(path.join(workspaceRoot, 'config.ts'), raw, 'utf8');
    const gateway = new LocalStagingGateway({ stagingRoot });
    const result = await gateway.stage({
      runId: 'run-4',
      request: 'Inspect',
      files: [{ relativePath: 'config.ts', sourceHash: createHash('sha256').update(redacted).digest('hex'), sizeBytes: Buffer.byteLength(raw), content: raw }],
      messages: [{ role: 'user', content: 'token=message-secret-123' }]
    });

    expect(await readFile(path.join(stagingRoot, result.stagingReference, 'config.ts'), 'utf8')).toBe(redacted);
    expect(await readFile(path.join(stagingRoot, result.stagingReference, 'recent-messages.json'), 'utf8')).toContain('[REDACTED]');
    expect(await readFile(path.join(stagingRoot, result.stagingReference, 'config.ts'), 'utf8')).not.toContain('secret-value-123');
    await gateway.cleanup(result.stagingReference);
  });
});
