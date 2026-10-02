import { createHash } from 'node:crypto';

import {
  WorkspaceBinaryFileError,
  WorkspaceDomainError,
  WorkspaceIoError,
  WorkspaceLimitExceededError,
  WorkspacePathNotFoundError,
  WorkspacePathForbiddenError,
  WorkspaceUnsupportedFileError
} from '@/modules/files/domain/workspace-errors';
import {
  isAllowedTextFile,
  isProtectedFileName,
  type WorkspaceInspectionPolicy,
  DEFAULT_WORKSPACE_INSPECTION_POLICY
} from '@/modules/files/domain/workspace-policy';
import type { IWorkspaceGateway } from '@/modules/files/repositories/workspace-gateway';
import type {
  WorkspaceEntry,
  WorkspaceListOptions,
  WorkspaceListResult,
  WorkspaceProjectScope,
  WorkspaceReadOptions,
  WorkspaceReadResult,
  WorkspaceSearchMatch,
  WorkspaceSearchOptions,
  WorkspaceSearchResult,
  WorkspaceTreeNode,
  WorkspaceTreeOptions,
  WorkspaceTreeResult
} from '@/modules/files/domain/workspace-types';
import type { IWorkspaceBoundary } from '@/modules/projects/repositories/workspace-boundary';
import {
  assertDirectory,
  assertInspectableComponent,
  mapWorkspaceFileSystemError,
  resolveWorkspaceEntry,
  resolveWorkspaceScope,
  safeLstat,
  type WorkspaceScopePaths
} from '@/infrastructure/workspace/workspace-gateway-paths';
import { WorkspaceRelativePath } from '@/modules/files/domain/workspace-path';
import {
  defaultWorkspaceGatewayFileSystem,
  isWorkspaceReparsePoint,
  type WorkspaceGatewayFileHandle,
  type WorkspaceGatewayFileSystem,
  type WorkspaceGatewayStats
} from '@/infrastructure/workspace/workspace-gateway-fs';
import { WorkspaceOperationContext } from '@/infrastructure/workspace/workspace-operation';
import { assertQueryLength, boundText, decodeUtf8, redactSensitiveText, truncateUtf8 } from '@/infrastructure/workspace/workspace-text';
import { createWorkspaceSearchQuery, extractWorkspaceSearchTerms, rankWorkspaceSearchLine, type WorkspaceSearchQuery } from '@/infrastructure/workspace/workspace-search-ranking';

export interface WorkspaceGatewayOptions {
  readonly containerRoot: string;
  readonly workspaceBoundary: IWorkspaceBoundary;
  readonly policy?: WorkspaceInspectionPolicy;
  readonly fileSystem?: WorkspaceGatewayFileSystem;
}

interface DirectoryEntryCandidate {
  readonly name: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly stats: WorkspaceGatewayStats;
}

interface TreeState {
  count: number;
  truncated: boolean;
}

export class WorkspaceGatewayAdapter implements IWorkspaceGateway {
  private readonly policy: WorkspaceInspectionPolicy;
  private readonly fileSystem: WorkspaceGatewayFileSystem;

  public constructor(private readonly options: WorkspaceGatewayOptions) {
    this.policy = options.policy ?? DEFAULT_WORKSPACE_INSPECTION_POLICY;
    this.fileSystem = options.fileSystem ?? defaultWorkspaceGatewayFileSystem;
  }

  public async list(scope: WorkspaceProjectScope, input: WorkspaceListOptions): Promise<WorkspaceListResult> {
    const context = this.createContext(input.signal);
    const paths = await this.prepareScope(scope, context);
    const directory = await resolveWorkspaceEntry(this.fileSystem, paths, input.directory, context, this.policy.maxPathLength);
    assertDirectory(directory.stats);
    const result = await this.readDirectoryEntries(paths, directory.path, directory.path, context, this.policy.maxListEntries);
    return { directory: directory.path, entries: result.entries.map(toWorkspaceEntry), truncated: result.truncated };
  }

  public async tree(scope: WorkspaceProjectScope, input: WorkspaceTreeOptions): Promise<WorkspaceTreeResult> {
    if (!Number.isSafeInteger(input.depth) || input.depth < 0 || input.depth > this.policy.maxTreeDepth) {
      throw new WorkspaceLimitExceededError('The requested workspace tree depth is outside the safe limit.');
    }
    const context = this.createContext(input.signal);
    const paths = await this.prepareScope(scope, context);
    const directory = await resolveWorkspaceEntry(this.fileSystem, paths, input.directory, context, this.policy.maxPathLength);
    assertDirectory(directory.stats);
    const state: TreeState = { count: 0, truncated: false };
    const entries = await this.readTreeEntries(paths, directory.path, input.depth, context, state);
    return { directory: directory.path, depth: input.depth, entries, truncated: state.truncated };
  }

  public async readText(scope: WorkspaceProjectScope, input: WorkspaceReadOptions): Promise<WorkspaceReadResult> {
    const context = this.createContext(input.signal);
    const paths = await this.prepareScope(scope, context);
    const entry = await resolveWorkspaceEntry(this.fileSystem, paths, input.path, context, this.policy.maxPathLength);
    assertReadableTextPath(entry.path, entry.stats, this.policy);
    const buffer = await this.readBounded(pathForEntry(paths, entry.path), this.policy.maxReadBytes, context);
    const decoded = decodeUtf8(buffer.bytes);
    const bounded = boundText(decoded, buffer.sizeBytes, this.policy.maxReadLines, this.policy.maxReadOutputBytes);
    return {
      path: entry.path,
      content: bounded.text,
      sourceHash: createHash('sha256').update(buffer.bytes).digest('hex'),
      encoding: 'utf-8',
      sizeBytes: bounded.sizeBytes,
      lineCount: decoded.split(/\r\n|\r|\n/u).length,
      truncated: bounded.truncated || buffer.truncated
    };
  }

  public async searchText(scope: WorkspaceProjectScope, input: WorkspaceSearchOptions): Promise<WorkspaceSearchResult> {
    assertQueryLength(input.query, this.policy.maxQueryLength);
    const context = this.createContext(input.signal);
    const paths = await this.prepareScope(scope, context);
    const directory = await resolveWorkspaceEntry(this.fileSystem, paths, input.directory, context, this.policy.maxPathLength);
    assertDirectory(directory.stats);
    const maxResults = input.maxResults ?? this.policy.maxSearchMatches;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > this.policy.maxSearchMatches) {
      throw new WorkspaceLimitExceededError('The requested workspace search result limit is outside the safe limit.');
    }
    const state: SearchState = { filesScanned: 0, linesScanned: 0, matchCount: 0, outputBytes: 0, truncated: false, matches: [], stop: false };
    const searchQuery = createWorkspaceSearchQuery(input.query);
    await this.searchDirectory(paths, directory.path, this.policy.maxTreeDepth, searchQuery, maxResults, context, state);
    return {
      directory: directory.path,
      query: input.query,
      matches: state.matches.map((ranked) => ranked.match),
      filesScanned: state.filesScanned,
      truncated: state.truncated || state.matchCount > state.matches.length
    };
  }

  private createContext(signal: AbortSignal | undefined): WorkspaceOperationContext {
    return new WorkspaceOperationContext(signal, this.policy.operationTimeoutMs);
  }

  private async prepareScope(scope: WorkspaceProjectScope, context: WorkspaceOperationContext): Promise<WorkspaceScopePaths> {
    await context.run(() => this.options.workspaceBoundary.assertReady());
    return resolveWorkspaceScope(this.options.workspaceBoundary, this.fileSystem, this.options.containerRoot, scope, context);
  }

  private async readDirectoryEntries(
    paths: WorkspaceScopePaths,
    directoryPath: string,
    relativeDirectory: string,
    context: WorkspaceOperationContext,
    limit: number
  ): Promise<{ readonly entries: readonly DirectoryEntryCandidate[]; readonly truncated: boolean }> {
    const absoluteDirectoryPath = pathForEntry(paths, directoryPath);
    const directoryStats = await safeLstat(this.fileSystem, absoluteDirectoryPath, context);
    assertDirectory(directoryStats);
    const inspectedEntryLimit = this.getInspectedEntryLimit(limit);
    let directoryNames: { readonly names: readonly string[]; readonly truncated: boolean };
    try {
      directoryNames = await this.readDirectoryNames(absoluteDirectoryPath, context, inspectedEntryLimit);
    } catch (error: unknown) {
      throw mapWorkspaceFileSystemError(error);
    }
    const entries: DirectoryEntryCandidate[] = [];
    let truncated = directoryNames.truncated;
    for (const name of directoryNames.names) {
      context.assertActive();
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      const relativePath = joinRelative(relativeDirectory, name);
      if (!isInspectablePath(relativePath, this.policy.maxPathLength)) {
        continue;
      }
      let stats: WorkspaceGatewayStats;
      try {
        stats = await safeLstat(this.fileSystem, pathForEntry(paths, relativePath), context);
      } catch (error: unknown) {
        if (error instanceof WorkspacePathNotFoundError) {
          continue;
        }
        throw error;
      }
      if (isWorkspaceReparsePoint(stats)) {
        continue;
      }
      if (!stats.isDirectory() && (!stats.isFile() || !isAllowedTextFile(relativePath, this.policy))) {
        continue;
      }
      if (stats.isFile() && (stats.size ?? 0) > this.policy.maxReadBytes) {
        continue;
      }
      if (stats.isFile() && !(await this.isUtf8Text(pathForEntry(paths, relativePath), context))) {
        continue;
      }
      entries.push({ name, relativePath, absolutePath: pathForEntry(paths, relativePath), stats });
    }
    return { entries, truncated };
  }

  private getInspectedEntryLimit(resultLimit: number): number {
    const configuredLimit = this.policy.maxDirectoryEntriesInspected ?? 2048;
    return Math.max(resultLimit, configuredLimit);
  }

  private async readDirectoryNames(
    directoryPath: string,
    context: WorkspaceOperationContext,
    inspectedEntryLimit: number
  ): Promise<{ readonly names: readonly string[]; readonly truncated: boolean }> {
    const iterator = await this.openDirectoryIterator(directoryPath, context);
    const names: string[] = [];
    try {
      while (true) {
        const next = await context.run(() => iterator.next());
        if (next.done) {
          return { names: names.sort(compareNames), truncated: false };
        }
        if (names.length >= inspectedEntryLimit) {
          return { names: names.sort(compareNames), truncated: true };
        }
        names.push(next.value);
      }
    } finally {
      await iterator.return?.();
    }
  }

  private async openDirectoryIterator(
    directoryPath: string,
    context: WorkspaceOperationContext
  ): Promise<AsyncIterator<string>> {
    if (this.fileSystem.iterateDirectory) {
      return this.fileSystem.iterateDirectory(directoryPath)[Symbol.asyncIterator]();
    }
    const names = await context.run(() => this.fileSystem.readDirectory(directoryPath));
    return (async function* (): AsyncGenerator<string> {
      for (const name of names) {
        yield name;
      }
    }())[Symbol.asyncIterator]();
  }

  private async isUtf8Text(filePath: string, context: WorkspaceOperationContext): Promise<boolean> {
    try {
      const bounded = await this.readBounded(filePath, this.policy.maxReadBytes, context);
      decodeUtf8(bounded.bytes);
      return true;
    } catch (error: unknown) {
      if (error instanceof WorkspaceBinaryFileError || error instanceof WorkspaceLimitExceededError) {
        return false;
      }
      throw error;
    }
  }

  private async readTreeEntries(
    paths: WorkspaceScopePaths,
    directoryPath: string,
    remainingDepth: number,
    context: WorkspaceOperationContext,
    state: TreeState
  ): Promise<readonly WorkspaceTreeNode[]> {
    const result = await this.readDirectoryEntries(paths, directoryPath, directoryPath, context, this.policy.maxTreeEntries);
    if (result.truncated) {
      state.truncated = true;
    }
    const nodes: WorkspaceTreeNode[] = [];
    for (const candidate of result.entries) {
      if (state.count >= this.policy.maxTreeEntries) {
        state.truncated = true;
        break;
      }
      state.count += 1;
      const entry = toWorkspaceEntry(candidate);
      if (!candidate.stats.isDirectory()) {
        nodes.push(entry);
        continue;
      }
      if (remainingDepth === 0) {
        if (await this.directoryHasEntries(candidate.absolutePath, context)) {
          state.truncated = true;
        }
        nodes.push(entry);
        continue;
      }
      const children = await this.readTreeEntries(paths, candidate.relativePath, remainingDepth - 1, context, state);
      nodes.push({ ...entry, children });
    }
    return nodes;
  }

  private async searchDirectory(
    paths: WorkspaceScopePaths,
    directoryPath: string,
    remainingDepth: number,
    query: WorkspaceSearchQuery,
    maxResults: number,
    context: WorkspaceOperationContext,
    state: SearchState
  ): Promise<void> {
    const result = await this.readDirectoryEntries(paths, directoryPath, directoryPath, context, this.policy.maxSearchFiles);
    if (result.truncated) {
      state.truncated = true;
    }
    for (const candidate of result.entries) {
      if (state.stop) {
        return;
      }
      if (candidate.stats.isDirectory()) {
        if (remainingDepth === 0) {
          state.truncated = true;
          continue;
        }
        await this.searchDirectory(paths, candidate.relativePath, remainingDepth - 1, query, maxResults, context, state);
        continue;
      }
      if (state.filesScanned >= this.policy.maxSearchFiles) {
        state.truncated = true;
        state.stop = true;
        return;
      }
      state.filesScanned += 1;
      await this.searchFile(paths, candidate, query, maxResults, context, state);
    }
  }

  private async searchFile(
    paths: WorkspaceScopePaths,
    candidate: DirectoryEntryCandidate,
    query: WorkspaceSearchQuery,
    maxResults: number,
    context: WorkspaceOperationContext,
    state: SearchState
  ): Promise<void> {
    if ((candidate.stats.size ?? 0) > this.policy.maxSearchFileBytes) {
      state.truncated = true;
      return;
    }
    let bounded: { readonly bytes: Buffer; readonly sizeBytes: number; readonly truncated: boolean };
    try {
      bounded = await this.readBounded(candidate.absolutePath, this.policy.maxSearchFileBytes, context);
    } catch (error: unknown) {
      if (error instanceof WorkspaceLimitExceededError) {
        state.truncated = true;
        return;
      }
      throw error;
    }
    if (bounded.truncated) {
      state.truncated = true;
      return;
    }
    let text: string;
    try {
      text = decodeUtf8(bounded.bytes);
    } catch (error: unknown) {
      if (error instanceof WorkspaceBinaryFileError) {
        return;
      }
      throw error;
    }
    const lines = redactSensitiveText(text).split(/\r\n|\r|\n/u);
    const remainingLineLimit = this.policy.maxSearchLines - state.linesScanned;
    if (remainingLineLimit <= 0) {
      state.truncated = true;
      state.stop = true;
      return;
    }
    if (lines.length > remainingLineLimit) {
      lines.length = remainingLineLimit;
      state.truncated = true;
      state.stop = true;
    }
    state.linesScanned += lines.length;
    const fileTerms = collectFileTerms(lines, query);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const relevance = rankWorkspaceSearchLine(line, query, fileTerms);
      if (!relevance) continue;
      const match: WorkspaceSearchMatch = {
        path: candidate.relativePath,
        line: index + 1,
        column: relevance.column,
        text: truncateUtf8(line, Math.min(this.policy.maxSearchLineBytes, this.policy.maxSearchOutputBytes))
      };
      state.matchCount += 1;
      insertRankedMatch(state, { match, score: relevance.score }, maxResults, this.policy.maxSearchOutputBytes);
    }
  }

  private async directoryHasEntries(directoryPath: string, context: WorkspaceOperationContext): Promise<boolean> {
    try {
      const result = await this.readDirectoryNames(directoryPath, context, 1);
      return result.names.length > 0 || result.truncated;
    } catch (error: unknown) {
      if (error instanceof WorkspaceDomainError) {
        throw error;
      }
      return true;
    }
  }

  private async readBounded(filePath: string, limit: number, context: WorkspaceOperationContext): Promise<{ readonly bytes: Buffer; readonly sizeBytes: number; readonly truncated: boolean }> {
    const initial = await safeLstat(this.fileSystem, filePath, context);
    assertInspectableComponent(initial);
    if (!initial.isFile()) {
      throw new WorkspacePathNotFoundError();
    }
    if ((initial.size ?? 0) > limit) {
      throw new WorkspaceLimitExceededError('The workspace file is larger than the safe read limit.');
    }
    let handle: WorkspaceGatewayFileHandle;
    try {
      handle = await context.run(() => this.fileSystem.openRead(filePath));
    } catch (error: unknown) {
      throw mapWorkspaceFileSystemError(error);
    }
    let result: { readonly bytes: Buffer; readonly sizeBytes: number; readonly truncated: boolean } | undefined;
    let failure: WorkspaceDomainError | undefined;
    try {
      const buffer = Buffer.alloc(limit + 1);
      let offset = 0;
      while (offset < buffer.length) {
        context.assertActive();
        const bytesRead = await context.run(() => handle.read(buffer, offset, buffer.length - offset, offset));
        if (bytesRead === 0) {
          break;
        }
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - offset) {
          throw new WorkspaceIoError();
        }
        offset += bytesRead;
      }
      if (offset > limit) {
        throw new WorkspaceLimitExceededError('The workspace file is larger than the safe read limit.');
      }
      const finalStats = await safeLstat(this.fileSystem, filePath, context);
      assertInspectableComponent(finalStats);
      if (!finalStats.isFile()) {
        throw new WorkspacePathNotFoundError();
      }
      result = { bytes: buffer.subarray(0, offset), sizeBytes: offset, truncated: false };
    } catch (error: unknown) {
      failure = error instanceof WorkspaceDomainError ? error : mapWorkspaceFileSystemError(error);
    } finally {
      try {
        await handle.close();
      } catch (error: unknown) {
        if (!failure) {
          failure = error instanceof WorkspaceDomainError ? error : new WorkspaceIoError();
        }
      }
    }
    if (failure) {
      throw failure;
    }
    if (!result) {
      throw new WorkspaceIoError();
    }
    return result;
  }
}

interface SearchState {
  filesScanned: number;
  linesScanned: number;
  matchCount: number;
  outputBytes: number;
  matches: RankedWorkspaceSearchMatch[];
  truncated: boolean;
  stop: boolean;
}

interface RankedWorkspaceSearchMatch {
  readonly match: WorkspaceSearchMatch;
  readonly score: number;
}

function collectFileTerms(lines: readonly string[], query: WorkspaceSearchQuery): ReadonlySet<string> {
  const terms = new Set<string>();
  const queryTerms = new Set(query.terms);
  for (const line of lines) {
    for (const term of extractWorkspaceSearchTerms(line)) if (queryTerms.has(term)) terms.add(term);
  }
  return terms;
}

function insertRankedMatch(state: SearchState, candidate: RankedWorkspaceSearchMatch, maxResults: number, maxOutputBytes: number): void {
  state.matches.push(candidate);
  state.matches.sort(compareRankedMatches);
  if (state.matches.length > maxResults) state.matches.pop();
  state.outputBytes = state.matches.reduce((total, item) => total + Buffer.byteLength(item.match.text, 'utf8'), 0);
  while (state.matches.length > 0 && state.outputBytes > maxOutputBytes) {
    const removed = state.matches.pop();
    if (removed) state.outputBytes -= Buffer.byteLength(removed.match.text, 'utf8');
  }
}

function compareRankedMatches(left: RankedWorkspaceSearchMatch, right: RankedWorkspaceSearchMatch): number {
  return right.score - left.score
    || compareWorkspacePath(left.match.path, right.match.path)
    || left.match.line - right.match.line
    || left.match.column - right.match.column;
}

function compareWorkspacePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertReadableTextPath(relativePath: string, stats: WorkspaceGatewayStats, policy: WorkspaceInspectionPolicy): void {
  if (isProtectedFileName(relativePath)) {
    throw new WorkspacePathForbiddenError();
  }
  if (!stats.isFile()) {
    throw new WorkspacePathNotFoundError();
  }
  if (!isAllowedTextFile(relativePath, policy)) {
    throw new WorkspaceUnsupportedFileError();
  }
}

function isInspectablePath(relativePath: string, maxPathLength: number): boolean {
  try {
    WorkspaceRelativePath.parse(relativePath, { maxLength: maxPathLength });
    return !isProtectedFileName(relativePath);
  } catch {
    return false;
  }
}

function pathForEntry(paths: WorkspaceScopePaths, relativePath: string): string {
  return relativePath.length === 0 ? paths.canonicalProjectRoot : `${paths.canonicalProjectRoot}/${relativePath}`;
}

function joinRelative(directory: string, name: string): string {
  return directory.length === 0 ? name : `${directory}/${name}`;
}

function toWorkspaceEntry(candidate: DirectoryEntryCandidate): WorkspaceEntry {
  return {
    path: candidate.relativePath,
    name: candidate.name,
    type: candidate.stats.isDirectory() ? 'directory' : 'file',
    ...(candidate.stats.isFile() && candidate.stats.size !== undefined ? { sizeBytes: candidate.stats.size } : {})
  };
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
