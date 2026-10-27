import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import { WorkspaceBoundaryUnavailableError } from '@/modules/projects/domain/project-errors';
import {
  WorkspaceBinaryFileError,
  WorkspaceIoError,
  WorkspaceLimitExceededError,
  WorkspacePathInvalidError,
  WorkspacePathNotFoundError,
  WorkspacePathForbiddenError,
  WorkspaceReparsePointError
} from '@/modules/files/domain/workspace-errors';
import type { WorkspaceGatewayFileHandle, WorkspaceGatewayFileSystem, WorkspaceGatewayStats } from '@/infrastructure/workspace/workspace-gateway-fs';
import type { WorkspaceInspectionPolicy } from '@/modules/files/domain/workspace-policy';
import { WorkspaceGatewayAdapter } from '@/infrastructure/workspace/workspace-gateway';
import { redactSensitiveText, truncateUtf8 } from '@/infrastructure/workspace/workspace-text';

const PROJECT = { ownerId: 'owner-1', projectId: 'project-1', storageKind: 'legacy' as const, relativeRoot: 'apps' } as const;

function stats(options: { directory?: boolean; file?: boolean; symbolicLink?: boolean; reparsePoint?: boolean; size?: number }): WorkspaceGatewayStats {
  return {
    ...(options.size === undefined ? {} : { size: options.size }),
    isDirectory: () => options.directory === true,
    isFile: () => options.file === true,
    isSymbolicLink: () => options.symbolicLink === true,
    isReparsePoint: () => options.reparsePoint === true
  };
}

interface FixtureFileSystemOptions {
  readonly directoryError?: Error;
  readonly openError?: Error;
  readonly readError?: Error;
  readonly closeError?: Error;
  readonly reparsePoint?: boolean;
  readonly extraFiles?: readonly string[];
  readonly fileContents?: Readonly<Record<string, string>>;
}

class FixtureBoundary implements IWorkspaceBoundary {
  public available = true;

  public async getSnapshot(): Promise<{ status: 'ready' | 'unavailable' }> {
    return this.available ? { status: 'ready' } : { status: 'unavailable' };
  }

  public async assertReady(): Promise<void> {
    if (!this.available) {
      throw new WorkspaceBoundaryUnavailableError();
    }
  }

  public async validateProjectRoot(relativeRoot: string): Promise<string> {
    await this.assertReady();
    return relativeRoot;
  }
}

class FixtureFileSystem implements WorkspaceGatewayFileSystem {
  private readonly entries = new Map<string, { readonly stats: WorkspaceGatewayStats; readonly content?: Buffer; readonly children?: readonly string[] }>();
  public closedHandles = 0;
  public iteratedNames = 0;
  public lstatCalls = 0;

  public constructor(private readonly options: FixtureFileSystemOptions = {}) {
    this.directory('/workspace', ['apps']);
    this.directory('/workspace/apps', ['src', 'README.md', '.env', 'binary.txt', 'link.ts', 'reparse.ts', 'large.ts', 'notes.txt', 'control-one.txt', 'control-many.txt', 'control-mixed.txt', 'control-c1.txt', ...(options.extraFiles ?? [])]);
    this.directory('/workspace/apps/src', ['main.ts', 'nested']);
    this.directory('/workspace/apps/src/nested', ['deep.ts']);
    this.file('/workspace/apps/README.md', '# Workspace\n');
    this.file('/workspace/apps/.env', 'NVIDIA_API_KEY=do-not-return\n');
    this.file('/workspace/apps/binary.txt', Buffer.from([0, 1, 2, 3]));
    this.file('/workspace/apps/link.ts', 'outside');
    this.entries.set('/workspace/apps/link.ts', { stats: stats({ file: true, symbolicLink: true }), content: Buffer.from('outside') });
    this.file('/workspace/apps/reparse.ts', 'outside');
    this.entries.set('/workspace/apps/reparse.ts', { stats: stats({ file: true, reparsePoint: true }), content: Buffer.from('outside') });
    this.file('/workspace/apps/large.ts', 'x'.repeat(300));
    this.file('/workspace/apps/notes.txt', 'before\n-----BEGIN RSA PRIVATE KEY-----\nSECRET_BODY_123456\n-----END RSA PRIVATE KEY-----\nafter\n');
    this.file('/workspace/apps/control-one.txt', Buffer.from([1]));
    this.file('/workspace/apps/control-many.txt', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    this.file('/workspace/apps/control-mixed.txt', Buffer.from([9, 10, 13, 31]));
    this.file('/workspace/apps/control-c1.txt', Buffer.from([0xc2, 0x81]));
    for (const fileName of options.extraFiles ?? []) {
      this.file(`/workspace/apps/${fileName}`, options.fileContents?.[fileName] ?? 'extra\n');
    }
    this.file('/workspace/apps/src/main.ts', 'const greeting = "世界";\nconst token = "secret-value";\n');
    this.file('/workspace/apps/src/nested/deep.ts', 'deep match\n');
  }

  public async lstat(filePath: string): Promise<WorkspaceGatewayStats> {
    this.lstatCalls += 1;
    const entry = this.entries.get(filePath);
    if (!entry) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    return entry.stats;
  }

  public async realpath(filePath: string): Promise<string> {
    if (!this.entries.has(filePath)) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    return filePath;
  }

  public async readDirectory(directoryPath: string): Promise<readonly string[]> {
    if (this.options.directoryError) {
      throw this.options.directoryError;
    }
    const children = this.entries.get(directoryPath)?.children;
    if (!children) {
      throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    }
    return children;
  }

  public async *iterateDirectory(directoryPath: string): AsyncIterable<string> {
    if (this.options.directoryError) {
      throw this.options.directoryError;
    }
    const children = this.entries.get(directoryPath)?.children;
    if (!children) {
      throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    }
    for (const child of children) {
      this.iteratedNames += 1;
      yield child;
    }
  }

  public async openRead(filePath: string): Promise<WorkspaceGatewayFileHandle> {
    if (this.options.openError) {
      throw this.options.openError;
    }
    const content = this.entries.get(filePath)?.content;
    if (!content) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    let offset = 0;
    return {
      read: async (buffer, bufferOffset, length) => {
        if (this.options.readError) {
          throw this.options.readError;
        }
        const available = Math.min(length, content.length - offset);
        if (available <= 0) {
          return 0;
        }
        content.copy(buffer, bufferOffset, offset, offset + available);
        offset += available;
        return available;
      },
      close: async () => {
        this.closedHandles += 1;
        if (this.options.closeError) {
          throw this.options.closeError;
        }
      }
    };
  }

  private directory(filePath: string, children: readonly string[]): void {
    this.entries.set(filePath, { stats: stats({ directory: true }), children });
  }

  private file(filePath: string, content: string | Buffer): void {
    const buffer = typeof content === 'string' ? Buffer.from(content) : content;
    this.entries.set(filePath, { stats: stats({ file: true, size: buffer.length }), content: buffer });
  }
}

const BASE_POLICY: WorkspaceInspectionPolicy = {
  maxPathLength: 2048,
  maxQueryLength: 256,
  maxListEntries: 200,
  maxTreeDepth: 6,
  maxTreeEntries: 1000,
  maxReadBytes: 256,
  maxReadLines: 4000,
  maxReadOutputBytes: 128 * 1024,
  maxSearchFiles: 200,
  maxSearchLines: 20_000,
  maxSearchMatches: 200,
  maxSearchFileBytes: 64 * 1024,
  maxSearchOutputBytes: 128 * 1024,
  maxSearchLineBytes: 16 * 1024,
  maxDirectoryEntriesInspected: 2048,
  operationTimeoutMs: 5000,
  allowedExtensions: ['.ts', '.txt', '.md'],
  allowedFileNames: ['readme']
} as const;

function makeGateway(boundary = new FixtureBoundary(), policy = BASE_POLICY) {
  return { gateway: new WorkspaceGatewayAdapter({ containerRoot: '/workspace', workspaceBoundary: boundary, fileSystem: new FixtureFileSystem(), policy }), boundary };
}

describe('WorkspaceGatewayAdapter', () => {
  it('reads any UTF-8 file name under the broad access policy while retaining secret and binary guards', async () => {
    const gateway = new WorkspaceGatewayAdapter({ containerRoot: '/workspace', workspaceBoundary: new FixtureBoundary(), fileSystem: new FixtureFileSystem({ extraFiles: ['New.svelte', '.gitignore', 'CUSTOM'] }), policy: { ...BASE_POLICY, allowedExtensions: ['*'] } });
    for (const file of ['New.svelte', '.gitignore', 'CUSTOM']) {
      await expect(gateway.readText(PROJECT, { path: file })).resolves.toMatchObject({ path: file, content: 'extra\n' });
    }
    await expect(gateway.readText(PROJECT, { path: '.env' })).rejects.toBeInstanceOf(WorkspacePathForbiddenError);
    await expect(gateway.readText(PROJECT, { path: 'binary.txt' })).rejects.toBeInstanceOf(WorkspaceBinaryFileError);
    await expect(gateway.readText(PROJECT, { path: '../outside.ts' })).rejects.toBeInstanceOf(WorkspacePathInvalidError);
  });

  it('lists safe project-relative entries and never returns host paths', async () => {
    const { gateway } = makeGateway();
    const result = await gateway.list(PROJECT, { directory: '' });
    expect(result.entries.map((entry) => entry.path)).toEqual(['README.md', 'notes.txt', 'src']);
    expect(JSON.stringify(result)).not.toContain('/workspace');
    expect(JSON.stringify(result)).not.toContain('C:\\');
  });

  it('reads Unicode text, redacts secret-like values, and preserves UTF-8 boundaries', async () => {
    const { gateway } = makeGateway();
    const result = await gateway.readText(PROJECT, { path: 'src/main.ts' });
    expect(result.content).toContain('世界');
    expect(result.content).toContain('token = "[REDACTED]"');
    expect(result.content).not.toContain('secret-value');
    expect(result.path).toBe('src/main.ts');
  });

  it('rejects traversal, protected files, binary files, oversized files, and links', async () => {
    const { gateway } = makeGateway();
    await expect(gateway.readText(PROJECT, { path: '../outside.ts' })).rejects.toBeInstanceOf(WorkspacePathInvalidError);
    await expect(gateway.readText(PROJECT, { path: '.env' })).rejects.toBeInstanceOf(WorkspacePathForbiddenError);
    await expect(gateway.readText(PROJECT, { path: 'binary.txt' })).rejects.toBeInstanceOf(WorkspaceBinaryFileError);
    await expect(gateway.readText(PROJECT, { path: 'large.ts' })).rejects.toBeInstanceOf(WorkspaceLimitExceededError);
    await expect(gateway.readText(PROJECT, { path: 'link.ts' })).rejects.toBeInstanceOf(WorkspaceReparsePointError);
    await expect(gateway.readText(PROJECT, { path: 'reparse.ts' })).rejects.toBeInstanceOf(WorkspaceReparsePointError);
  });

  it.each(['control-one.txt', 'control-many.txt', 'control-mixed.txt', 'control-c1.txt'])('fails closed for small control payload %s', async (filePath) => {
    const { gateway } = makeGateway();
    await expect(gateway.readText(PROJECT, { path: filePath })).rejects.toBeInstanceOf(WorkspaceBinaryFileError);
  });

  it('redacts multiline private-key material before matching search lines', async () => {
    const { gateway } = makeGateway();
    const secretBodySearch = await gateway.searchText(PROJECT, { directory: '', query: 'SECRET_BODY_123456' });
    expect(secretBodySearch.matches).toEqual([]);
    const surroundingTextSearch = await gateway.searchText(PROJECT, { directory: '', query: 'after' });
    expect(surroundingTextSearch.matches[0]).toMatchObject({ path: 'notes.txt', line: 5, text: 'after' });
  });

  it('ranks multi-word relevance across the bounded scan before applying the result limit', async () => {
    const fileSystem = new FixtureFileSystem({
      extraFiles: ['a-noise.txt', 'z-context.ts'],
      fileContents: {
        'a-noise.txt': 'This note mentions project only.\n',
        'z-context.ts': 'Project overview.\nTask suggestion completion uses a writer.\n'
      }
    });
    const gateway = new WorkspaceGatewayAdapter({ containerRoot: '/workspace', workspaceBoundary: new FixtureBoundary(), fileSystem, policy: { ...BASE_POLICY, maxSearchMatches: 1 } });
    const startedAt = performance.now();
    const result = await gateway.searchText(PROJECT, { directory: '', query: 'project task suggestion', maxResults: 1 });
    const elapsedMs = performance.now() - startedAt;

    expect(result.matches).toEqual([{ path: 'z-context.ts', line: 2, column: 1, text: 'Task suggestion completion uses a writer.' }]);
    expect(result.filesScanned).toBeLessThanOrEqual(BASE_POLICY.maxSearchFiles);
    expect(result.truncated).toBe(true);
    expect(elapsedMs).toBeLessThan(BASE_POLICY.operationTimeoutMs);
    expect(result.matches.reduce((bytes, match) => bytes + Buffer.byteLength(match.text, 'utf8'), 0)).toBeLessThanOrEqual(BASE_POLICY.maxSearchOutputBytes);
  });

  it('benchmarks retrieval quality and latency with a repository-shaped synthetic corpus', async () => {
    const decoyFiles = Array.from({ length: 118 }, (_, index) => `decoy-${String(index).padStart(3, '0')}.txt`);
    const fileContents = Object.fromEntries(decoyFiles.map((fileName) => [fileName, 'Provider endpoint settings are documented here.\n']));
    fileContents['a-overview.txt'] = 'Provider overview without task details.\n';
    fileContents['z-task-suggestions.ts'] = 'Task suggestion lifecycle\nThe provider saves the accepted task suggestion after completion.\n';
    const fileSystem = new FixtureFileSystem({ extraFiles: [...decoyFiles, 'a-overview.txt', 'z-task-suggestions.ts'], fileContents });
    const gateway = new WorkspaceGatewayAdapter({ containerRoot: '/workspace', workspaceBoundary: new FixtureBoundary(), fileSystem, policy: BASE_POLICY });
    const startedAt = performance.now();
    const result = await gateway.searchText(PROJECT, { directory: '', query: 'provider task suggestion', maxResults: 10 });
    const elapsedMs = performance.now() - startedAt;
    const outputTextBytes = result.matches.reduce((bytes, match) => bytes + Buffer.byteLength(match.text, 'utf8'), 0);

    expect(result.matches[0]).toMatchObject({ path: 'z-task-suggestions.ts', line: 2 });
    expect(result.filesScanned).toBeLessThanOrEqual(BASE_POLICY.maxSearchFiles);
    expect(outputTextBytes).toBeLessThanOrEqual(BASE_POLICY.maxSearchOutputBytes);
    expect(result.truncated).toBe(true);
    expect(elapsedMs).toBeLessThan(BASE_POLICY.operationTimeoutMs);
    if (process.env.PAI_CONTEXT_SEARCH_BENCHMARK === '1') {
      process.stdout.write(`CONTEXT_SEARCH_BENCHMARK ${JSON.stringify({ query: 'provider task suggestion', filesScanned: result.filesScanned, returnedMatches: result.matches.length, outputTextBytes, elapsedMs: Number(elapsedMs.toFixed(2)), topPath: result.matches[0]?.path })}\n`);
    }
  });

  it('orders tied matches by path and line regardless of discovery order', async () => {
    const fileSystem = new FixtureFileSystem({
      extraFiles: ['z-last.txt', 'a-first.txt'],
      fileContents: { 'z-last.txt': 'shared search term\n', 'a-first.txt': 'shared search term\n' }
    });
    const gateway = new WorkspaceGatewayAdapter({ containerRoot: '/workspace', workspaceBoundary: new FixtureBoundary(), fileSystem, policy: BASE_POLICY });

    const result = await gateway.searchText(PROJECT, { directory: '', query: 'shared search term' });

    expect(result.matches.slice(0, 2).map((match) => match.path)).toEqual(['a-first.txt', 'z-last.txt']);
  });

  it('bounds tree depth, search results, and redacts search matches', async () => {
    const { gateway } = makeGateway(undefined, {
      ...BASE_POLICY,
      maxSearchMatches: 1
    });
    const tree = await gateway.tree(PROJECT, { directory: '', depth: 0 });
    expect(tree.entries.find((entry) => entry.path === 'src')?.children).toBeUndefined();
    expect(tree.truncated).toBe(true);
    const search = await gateway.searchText(PROJECT, { directory: '', query: 'match', maxResults: 1 });
    expect(search.matches).toHaveLength(1);
    expect(search.matches[0]?.text).toContain('match');
    expect(search.truncated).toBe(false);
  });

  it('does not let a depth boundary suppress files at the current level', async () => {
    const { gateway } = makeGateway(undefined, { ...BASE_POLICY, maxTreeDepth: 0 });
    const result = await gateway.searchText(PROJECT, { directory: '', query: 'Workspace' });
    expect(result.matches.map((match) => match.path)).toEqual(['README.md']);
    expect(result.truncated).toBe(true);
  });

  it('rejects a configured path length before touching the filesystem', async () => {
    const { gateway } = makeGateway(undefined, { ...BASE_POLICY, maxPathLength: 5 });
    await expect(gateway.readText(PROJECT, { path: 'src/main.ts' })).rejects.toBeInstanceOf(WorkspacePathInvalidError);
  });

  it('maps open and read failures to safe typed errors and always closes a handle', async () => {
    const directoryFileSystem = new FixtureFileSystem({ directoryError: new Error('directory failed') });
    const directoryGateway = new WorkspaceGatewayAdapter({ containerRoot: '/workspace', workspaceBoundary: new FixtureBoundary(), fileSystem: directoryFileSystem, policy: BASE_POLICY });
    await expect(directoryGateway.list(PROJECT, { directory: '' })).rejects.toBeInstanceOf(WorkspaceIoError);

    const openFileSystem = new FixtureFileSystem({ openError: Object.assign(new Error('missing'), { code: 'ENOENT' }) });
    const openGateway = new WorkspaceGatewayAdapter({ containerRoot: '/workspace', workspaceBoundary: new FixtureBoundary(), fileSystem: openFileSystem, policy: BASE_POLICY });
    await expect(openGateway.readText(PROJECT, { path: 'README.md' })).rejects.toBeInstanceOf(WorkspacePathNotFoundError);

    const readFileSystem = new FixtureFileSystem({ readError: new Error('read failed') });
    const readGateway = new WorkspaceGatewayAdapter({ containerRoot: '/workspace', workspaceBoundary: new FixtureBoundary(), fileSystem: readFileSystem, policy: BASE_POLICY });
    await expect(readGateway.readText(PROJECT, { path: 'README.md' })).rejects.toBeInstanceOf(WorkspaceIoError);
    expect(readFileSystem.closedHandles).toBe(1);

    const closeFileSystem = new FixtureFileSystem({ closeError: new Error('close failed') });
    const closeGateway = new WorkspaceGatewayAdapter({ containerRoot: '/workspace', workspaceBoundary: new FixtureBoundary(), fileSystem: closeFileSystem, policy: BASE_POLICY });
    await expect(closeGateway.readText(PROJECT, { path: 'README.md' })).rejects.toBeInstanceOf(WorkspaceIoError);
    expect(closeFileSystem.closedHandles).toBe(1);
  });

  it('truncates UTF-8 output at code-point boundaries after redaction', async () => {
    expect(truncateUtf8('A🙂中B', 5)).toBe('A🙂');
    const { gateway } = makeGateway(undefined, { ...BASE_POLICY, maxSearchLineBytes: 13 });
    const result = await gateway.searchText(PROJECT, { directory: '', query: 'token' });
    expect(result.matches).toHaveLength(1);
    expect(Buffer.byteLength(result.matches[0]?.text ?? '', 'utf8')).toBeLessThanOrEqual(13);
    expect(result.matches[0]?.text).not.toContain('secret-value');
  });

  it('bounds read output bytes and redacts private-key material', async () => {
    const { gateway } = makeGateway(undefined, { ...BASE_POLICY, maxReadOutputBytes: 5 });
    const result = await gateway.readText(PROJECT, { path: 'src/main.ts' });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(5);
    expect(redactSensitiveText('-----BEGIN RSA PRIVATE KEY-----secret-----END RSA PRIVATE KEY-----')).toBe('[REDACTED PRIVATE KEY]');
  });

  it('fails closed when the configured workspace identity is unavailable', async () => {
    const { gateway, boundary } = makeGateway();
    boundary.available = false;
    await expect(gateway.list(PROJECT, { directory: '' })).rejects.toBeInstanceOf(WorkspaceBoundaryUnavailableError);
  });

  it('caps directory enumeration before sorting and classifying entries', async () => {
    const extraFiles = Array.from({ length: 100 }, (_, index) => `extra-${index}.txt`);
    const fileSystem = new FixtureFileSystem({ extraFiles });
    const gateway = new WorkspaceGatewayAdapter({
      containerRoot: '/workspace',
      workspaceBoundary: new FixtureBoundary(),
      fileSystem,
      policy: { ...BASE_POLICY, maxListEntries: 1, maxDirectoryEntriesInspected: 5 }
    });
    const result = await gateway.list(PROJECT, { directory: '' });
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(fileSystem.iteratedNames).toBeLessThanOrEqual(6);
    expect(fileSystem.lstatCalls).toBeLessThanOrEqual(6);
  });
});
