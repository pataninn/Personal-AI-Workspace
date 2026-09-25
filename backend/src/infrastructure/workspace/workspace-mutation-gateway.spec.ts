import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import type { ProposedChangeOperation } from '@/modules/ai-runs/domain/change-types';
import type { MutationFileSystem } from '@/infrastructure/workspace/workspace-mutation-gateway';
import { WorkspaceMutationGatewayAdapter } from '@/infrastructure/workspace/workspace-mutation-gateway';

const SCOPE = { projectId: 'project-1', relativeRoot: 'project' } as const;
const RUN_ID = 'run-1';
const PROPOSAL_HASH = 'a'.repeat(64);

class BoundaryFixture implements IWorkspaceBoundary {
  public async getSnapshot(): Promise<{ status: 'ready' }> { return { status: 'ready' }; }
  public async assertReady(): Promise<void> { return undefined; }
  public async validateProjectRoot(relativeRoot: string): Promise<string> { return relativeRoot; }
}

describe('WorkspaceMutationGatewayAdapter', () => {
  let root: string;
  let projectRoot: string;
  let recoveryRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pai-change-set-'));
    projectRoot = path.join(root, 'project');
    recoveryRoot = path.join(root, 'recovery');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'edit.txt'), 'edit-before\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'overwrite.txt'), 'overwrite-before\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'rename.txt'), 'rename-before\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'delete.txt'), 'delete-before\n', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('applies create, edit, overwrite, rename, and delete with exact hashes and recovery backups', async () => {
    const adapter = makeAdapter(root, recoveryRoot);
    const operations = [
      operation('create', 'created.txt', { content: 'created\n' }),
      operation('edit', 'edit.txt', { content: 'edit-after\n', expectedSourceHash: hash('edit-before\n') }),
      operation('overwrite', 'overwrite.txt', { content: 'overwrite-after\n', expectedSourceHash: hash('overwrite-before\n') }),
      operation('rename', 'rename.txt', { destinationPath: 'renamed.txt', expectedSourceHash: hash('rename-before\n') }),
      operation('delete', 'delete.txt', { expectedSourceHash: hash('delete-before\n') })
    ] satisfies readonly ProposedChangeOperation[];

    const result = await adapter.applyChangeSet(SCOPE, operations, RUN_ID, PROPOSAL_HASH);

    expect(result.outcome).toBe('applied');
    expect(result.operations.every((item) => item.status === 'applied')).toBe(true);
    expect(result.operations.find((item) => item.operation === 'rename')?.safeMessage).toBe('Renamed.');
    await expect(fs.readFile(path.join(projectRoot, 'created.txt'), 'utf8')).resolves.toBe('created\n');
    await expect(fs.readFile(path.join(projectRoot, 'edit.txt'), 'utf8')).resolves.toBe('edit-after\n');
    await expect(fs.readFile(path.join(projectRoot, 'overwrite.txt'), 'utf8')).resolves.toBe('overwrite-after\n');
    await expect(fs.readFile(path.join(projectRoot, 'renamed.txt'), 'utf8')).resolves.toBe('rename-before\n');
    await expect(fs.access(path.join(projectRoot, 'rename.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(projectRoot, 'delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.operations.filter((item) => item.backup === 'created')).toHaveLength(2);
    await expect(fs.readFile(path.join(recoveryRoot, `run-${RUN_ID}`, PROPOSAL_HASH, operations[2]!.operationId, 'overwrite.txt.bak'), 'utf8')).resolves.toBe('overwrite-before\n');
    await expect(fs.readFile(path.join(recoveryRoot, `run-${RUN_ID}`, PROPOSAL_HASH, operations[4]!.operationId, 'delete.txt.bak'), 'utf8')).resolves.toBe('delete-before\n');
  });

  it('allows reviewed root-project changes but still rejects protected root paths', async () => {
    const rootScope = { projectId: 'project-1', relativeRoot: '.' } as const;
    const adapter = makeAdapter(root, recoveryRoot);
    await fs.writeFile(path.join(root, 'root-edit.txt'), 'root-before\n', 'utf8');
    const rootEdit = operation('edit', 'root-edit.txt', { content: 'root-after\n', expectedSourceHash: hash('root-before\n') });

    const result = await adapter.applyChangeSet(rootScope, [rootEdit], RUN_ID, PROPOSAL_HASH);

    expect(result.outcome).toBe('applied');
    await expect(fs.readFile(path.join(root, 'root-edit.txt'), 'utf8')).resolves.toBe('root-after\n');
    await expect(adapter.inspect(rootScope, '.env')).rejects.toMatchObject({ code: 'WORKSPACE_PATH_FORBIDDEN' });
    await expect(adapter.inspect(rootScope, '.git/config')).rejects.toMatchObject({ code: 'WORKSPACE_PATH_FORBIDDEN' });
  });

  it('returns stale and performs no writes when a precondition hash is no longer current', async () => {
    const adapter = makeAdapter(root, recoveryRoot);
    const operationToApply = operation('edit', 'edit.txt', { content: 'unsafe\n', expectedSourceHash: hash('edit-before\n') });
    await fs.writeFile(path.join(projectRoot, 'edit.txt'), 'changed-by-user\n', 'utf8');

    const result = await adapter.applyChangeSet(SCOPE, [operationToApply], RUN_ID, PROPOSAL_HASH);

    expect(result.outcome).toBe('stale');
    expect(result.conflict?.path).toBe('edit.txt');
    await expect(fs.readFile(path.join(projectRoot, 'edit.txt'), 'utf8')).resolves.toBe('changed-by-user\n');
    expect(result.operations[0]?.status).toBe('skipped');
  });

  it('fails closed before mutation when a recovery backup cannot be opened', async () => {
    const realOpen = fs.open.bind(fs);
    const fileSystem: MutationFileSystem = {
      lstat: (filePath) => fs.lstat(filePath),
      realpath: (filePath) => fs.realpath(filePath),
      readFile: (filePath) => fs.readFile(filePath),
      mkdir: async (directoryPath, options) => { await fs.mkdir(directoryPath, options); },
      open: async (filePath, flags) => {
        if (filePath.includes(`${path.sep}recovery${path.sep}`)) {
          throw Object.assign(new Error('recovery unavailable'), { code: 'EACCES' });
        }
        return realOpen(filePath, flags);
      },
      rename: (sourcePath, destinationPath) => fs.rename(sourcePath, destinationPath),
      unlink: (filePath) => fs.unlink(filePath),
      rm: (filePath, options) => fs.rm(filePath, { ...options, recursive: false })
    };
    const adapter = new WorkspaceMutationGatewayAdapter({ containerRoot: root, recoveryRoot, workspaceBoundary: new BoundaryFixture(), fileSystem });
    const change = operation('delete', 'delete.txt', { expectedSourceHash: hash('delete-before\n') });

    const result = await adapter.applyChangeSet(SCOPE, [change], RUN_ID, PROPOSAL_HASH);

    expect(result.outcome).toBe('needs_manual_review');
    expect(result.operations[0]).toMatchObject({ status: 'needs_manual_review', backup: 'unknown' });
    await expect(fs.readFile(path.join(projectRoot, 'delete.txt'), 'utf8')).resolves.toBe('delete-before\n');
  });

  it('rejects a missing exact source hash before touching the workspace', async () => {
    let filesystemCalls = 0;
    const real = makeFileSystem(() => { filesystemCalls += 1; });
    const adapter = makeAdapter(root, recoveryRoot, real);
    const change = operation('delete', 'delete.txt');

    await expect(adapter.applyChangeSet(SCOPE, [change], RUN_ID, PROPOSAL_HASH)).rejects.toMatchObject({ code: 'CHANGE_SET_INVALID' });
    expect(filesystemCalls).toBe(0);
  });

  it('fails closed when a trusted-process reparse race appears at the final delete boundary', async () => {
    let targetChecks = 0;
    const fileSystem = makeFileSystem(undefined, (filePath, stats) => {
      if (filePath.endsWith(`${path.sep}delete.txt`) && ++targetChecks >= 3) {
        return { ...stats, isSymbolicLink: () => true };
      }
      return stats;
    });
    const adapter = makeAdapter(root, recoveryRoot, fileSystem);
    const result = await adapter.applyChangeSet(SCOPE, [operation('delete', 'delete.txt', { expectedSourceHash: hash('delete-before\n') })], RUN_ID, PROPOSAL_HASH);

    expect(result.outcome).toBe('needs_manual_review');
    expect(result.operations[0]?.status).toBe('needs_manual_review');
    await expect(fs.readFile(path.join(projectRoot, 'delete.txt'), 'utf8')).resolves.toBe('delete-before\n');
  });

  it('returns stale when the source hash changes at the backup-to-I/O boundary', async () => {
    let reads = 0;
    const fileSystem = makeFileSystem(undefined, undefined, (filePath, bytes) => {
      if (filePath.endsWith(`${path.sep}edit.txt`) && ++reads >= 3) return Buffer.from('changed-during-check\n', 'utf8');
      return bytes;
    });
    const adapter = makeAdapter(root, recoveryRoot, fileSystem);
    const result = await adapter.applyChangeSet(SCOPE, [operation('edit', 'edit.txt', { content: 'unsafe\n', expectedSourceHash: hash('edit-before\n') })], RUN_ID, PROPOSAL_HASH);

    expect(result.outcome).toBe('stale');
    await expect(fs.readFile(path.join(projectRoot, 'edit.txt'), 'utf8')).resolves.toBe('edit-before\n');
  });

  it('requires the rename destination occupancy precondition and detects a newly occupied destination', async () => {
    const adapter = makeAdapter(root, recoveryRoot);
    const change = operation('rename', 'rename.txt', { destinationPath: 'renamed.txt', expectedSourceHash: hash('rename-before\n'), destinationPresent: false });
    await fs.writeFile(path.join(projectRoot, 'renamed.txt'), 'occupied\n', 'utf8');

    const result = await adapter.applyChangeSet(SCOPE, [change], RUN_ID, PROPOSAL_HASH);

    expect(result.outcome).toBe('stale');
    await expect(fs.readFile(path.join(projectRoot, 'rename.txt'), 'utf8')).resolves.toBe('rename-before\n');
  });

  it('returns stale when a same-root delete target swaps immediately before the claim rename', async () => {
    const fileSystem = makeFileSystem(undefined, undefined, undefined, undefined, async (sourcePath, destinationPath) => {
      if (sourcePath.endsWith(`${path.sep}delete.txt`) && destinationPath.endsWith('.claim')) {
        await fs.writeFile(sourcePath, 'changed-before-claim\n', 'utf8');
      }
    });
    const adapter = makeAdapter(root, recoveryRoot, fileSystem);

    const result = await adapter.applyChangeSet(SCOPE, [operation('delete', 'delete.txt', { expectedSourceHash: hash('delete-before\n') })], RUN_ID, PROPOSAL_HASH);

    expect(result.outcome).toBe('stale');
    await expect(fs.readFile(path.join(projectRoot, 'delete.txt'), 'utf8')).resolves.toBe('changed-before-claim\n');
  });

  it('returns stale when a same-root overwrite target swaps immediately before the claim rename', async () => {
    const fileSystem = makeFileSystem(undefined, undefined, undefined, undefined, async (sourcePath, destinationPath) => {
      if (sourcePath.endsWith(`${path.sep}overwrite.txt`) && destinationPath.endsWith('.claim')) {
        await fs.writeFile(sourcePath, 'changed-before-claim\n', 'utf8');
      }
    });
    const adapter = makeAdapter(root, recoveryRoot, fileSystem);

    const result = await adapter.applyChangeSet(SCOPE, [operation('overwrite', 'overwrite.txt', { content: 'unsafe\n', expectedSourceHash: hash('overwrite-before\n') })], RUN_ID, PROPOSAL_HASH);

    expect(result.outcome).toBe('stale');
    await expect(fs.readFile(path.join(projectRoot, 'overwrite.txt'), 'utf8')).resolves.toBe('changed-before-claim\n');
  });

  it('returns stale when a same-root source rename swaps immediately before the claim rename', async () => {
    const fileSystem = makeFileSystem(undefined, undefined, undefined, undefined, async (sourcePath, destinationPath) => {
      if (sourcePath.endsWith(`${path.sep}rename.txt`) && destinationPath.endsWith('.claim')) {
        await fs.writeFile(sourcePath, 'changed-before-claim\n', 'utf8');
      }
    });
    const adapter = makeAdapter(root, recoveryRoot, fileSystem);

    const result = await adapter.applyChangeSet(SCOPE, [operation('rename', 'rename.txt', { destinationPath: 'renamed.txt', expectedSourceHash: hash('rename-before\n'), destinationPresent: false })], RUN_ID, PROPOSAL_HASH);

    expect(result.outcome).toBe('stale');
    await expect(fs.readFile(path.join(projectRoot, 'rename.txt'), 'utf8')).resolves.toBe('changed-before-claim\n');
    await expect(fs.access(path.join(projectRoot, 'renamed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns stale when a destination-replacing rename swaps immediately before the destination claim', async () => {
    const destinationPath = path.join(projectRoot, 'rename-destination.txt');
    await fs.writeFile(destinationPath, 'destination-before\n', 'utf8');
    const fileSystem = makeFileSystem(undefined, undefined, undefined, undefined, async (sourcePath, destination) => {
      if (sourcePath.endsWith(`${path.sep}rename-destination.txt`) && destination.endsWith('.claim')) {
        await fs.writeFile(sourcePath, 'changed-before-claim\n', 'utf8');
      }
    });
    const adapter = makeAdapter(root, recoveryRoot, fileSystem);

    const result = await adapter.applyChangeSet(SCOPE, [operation('rename', 'rename.txt', {
      destinationPath: 'rename-destination.txt',
      expectedSourceHash: hash('rename-before\n'),
      expectedDestinationHash: hash('destination-before\n'),
      destinationPresent: true
    })], RUN_ID, PROPOSAL_HASH);

    expect(result.outcome).toBe('stale');
    await expect(fs.readFile(path.join(projectRoot, 'rename.txt'), 'utf8')).resolves.toBe('rename-before\n');
    await expect(fs.readFile(destinationPath, 'utf8')).resolves.toBe('changed-before-claim\n');
  });

  it('records a private claim checkpoint for an empty-destination rename without marking it destructive', async () => {
    const checkpoints: string[] = [];
    const adapter = makeAdapter(root, recoveryRoot);

    const result = await adapter.applyChangeSet(
      SCOPE,
      [operation('rename', 'rename.txt', { destinationPath: 'renamed.txt', expectedSourceHash: hash('rename-before\n'), destinationPresent: false })],
      RUN_ID,
      PROPOSAL_HASH,
      { recordBackupCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint.reference); } }
    );

    expect(result.outcome).toBe('applied');
    expect(result.operations[0]).toMatchObject({ backup: 'not_required', safeMessage: 'Renamed.' });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toContain('.claim');
  });

  it('fails closed to manual review when a stale claim cannot be restored', async () => {
    const fileSystem = makeFileSystem(undefined, undefined, undefined, undefined, async (sourcePath, destinationPath) => {
      if (sourcePath.endsWith(`${path.sep}overwrite.txt`) && destinationPath.endsWith('.claim')) {
        await fs.writeFile(sourcePath, 'changed-before-claim\n', 'utf8');
      }
      if (sourcePath.endsWith('.claim') && destinationPath.endsWith(`${path.sep}overwrite.txt`)) {
        throw Object.assign(new Error('restore unavailable'), { code: 'EACCES' });
      }
    });
    const adapter = makeAdapter(root, recoveryRoot, fileSystem);

    const result = await adapter.applyChangeSet(SCOPE, [operation('overwrite', 'overwrite.txt', { content: 'unsafe\n', expectedSourceHash: hash('overwrite-before\n') })], RUN_ID, PROPOSAL_HASH);

    expect(result.outcome).toBe('needs_manual_review');
    expect(result.operations[0]).toMatchObject({ status: 'needs_manual_review' });
    await expect(fs.readFile(path.join(projectRoot, 'overwrite.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function makeAdapter(containerRoot: string, recoveryRoot: string, fileSystem?: MutationFileSystem): WorkspaceMutationGatewayAdapter {
  return new WorkspaceMutationGatewayAdapter({ containerRoot, recoveryRoot, workspaceBoundary: new BoundaryFixture(), ...(fileSystem ? { fileSystem } : {}) });
}

function operation(operationKind: ProposedChangeOperation['operation'], relativePath: string, overrides: Partial<ProposedChangeOperation> = {}): ProposedChangeOperation {
  return {
    operationId: `${operationKind}-${relativePath}`,
    operation: operationKind,
    path: relativePath,
    summary: `${operationKind} ${relativePath}`,
    sourcePresent: operationKind !== 'create',
    destinationPresent: false,
    backupRequired: operationKind !== 'create',
    sizeBytes: 16,
    lineCount: 1,
    reviewable: true,
    ...overrides
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeFileSystem(
  onCall?: () => void,
  transformStats?: (filePath: string, stats: TestStats) => TestStats,
  transformBytes?: (filePath: string, bytes: Buffer) => Buffer,
  onLstat?: (filePath: string, stats: TestStats) => void | Promise<void>,
  beforeRename?: (sourcePath: string, destinationPath: string) => void | Promise<void>
): MutationFileSystem {
  const realOpen = fs.open.bind(fs);
  return {
    lstat: async (filePath) => {
      onCall?.();
      const actual = await fs.lstat(filePath);
      const stats: TestStats = { size: Number(actual.size), isFile: () => actual.isFile(), isDirectory: () => actual.isDirectory(), isSymbolicLink: () => actual.isSymbolicLink() };
      const transformed = transformStats?.(filePath, stats) ?? stats;
      await onLstat?.(filePath, transformed);
      return transformed;
    },
    realpath: (filePath) => fs.realpath(filePath),
    readFile: async (filePath) => {
      const bytes = await fs.readFile(filePath);
      return transformBytes?.(filePath, bytes) ?? bytes;
    },
    mkdir: async (directoryPath, options) => { await fs.mkdir(directoryPath, options); },
    open: (filePath, flags) => realOpen(filePath, flags),
    rename: async (sourcePath, destinationPath) => { await beforeRename?.(sourcePath, destinationPath); await fs.rename(sourcePath, destinationPath); },
    unlink: (filePath) => fs.unlink(filePath),
    rm: (filePath, options) => fs.rm(filePath, { ...options, recursive: false })
  };
}

interface TestStats {
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
