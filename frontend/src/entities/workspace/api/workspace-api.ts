import { getJson } from '@/shared/api';
import type { WorkspaceFileCandidate, WorkspaceFileSearchMatch, WorkspaceFileSearchResponse, WorkspaceTreeNode, WorkspaceTreeResponse } from '@/entities/workspace/model/types';

const PROJECTS_PATH = '/api/v1/projects';
const MAX_TREE_DEPTH = 6;
const MAX_FILES = 500;
const MAX_SEARCH_RESULTS = 50;

export function getWorkspaceTree(projectId: string, depth = 4): Promise<WorkspaceTreeResponse> {
  const boundedDepth = Math.max(0, Math.min(MAX_TREE_DEPTH, Math.floor(depth)));
  return getJson<unknown>(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}/files/tree?depth=${boundedDepth}`).then((value) => normalizeWorkspaceTree(value));
}

export function searchWorkspaceFiles(projectId: string, query: string, maxResults = MAX_SEARCH_RESULTS): Promise<WorkspaceFileSearchResponse> {
  const boundedResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(maxResults)));
  const parameters = new URLSearchParams({ query: query.trim(), maxResults: String(boundedResults) });
  return getJson<unknown>(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}/files/search?${parameters.toString()}`)
    .then((value) => normalizeWorkspaceSearch(value));
}

export function flattenWorkspaceFiles(tree: WorkspaceTreeResponse): readonly WorkspaceFileCandidate[] {
  const files: WorkspaceFileCandidate[] = [];
  visitNodes(tree.entries, files);
  return files.slice(0, MAX_FILES);
}

export function normalizeWorkspaceTree(value: unknown): WorkspaceTreeResponse {
  const record = asRecord(value);
  if (!record) {
    throw new Error('The local app returned an invalid workspace tree.');
  }
  const entries = Array.isArray(record.entries) ? normalizeNodes(record.entries, 0) : [];
  return {
    directory: safeDirectory(record.directory),
    depth: readNonNegativeInteger(record.depth),
    entries,
    truncated: record.truncated === true
  };
}

export function normalizeWorkspaceSearch(value: unknown): WorkspaceFileSearchResponse {
  const record = asRecord(value);
  if (!record) throw new Error('The local app returned invalid project search results.');
  const rawMatches = Array.isArray(record.matches) ? record.matches : [];
  const matches = normalizeSearchMatches(rawMatches);
  return {
    directory: safeDirectory(record.directory),
    query: typeof record.query === 'string' ? record.query.slice(0, 256) : '',
    matches,
    filesScanned: readNonNegativeInteger(record.filesScanned),
    truncated: record.truncated === true || rawMatches.length > matches.length
  };
}

function visitNodes(nodes: readonly WorkspaceTreeNode[], files: WorkspaceFileCandidate[]): void {
  for (const node of nodes) {
    if (files.length >= MAX_FILES) {
      return;
    }
    if (node.type === 'file') {
      files.push({ path: node.path, sizeBytes: node.sizeBytes ?? 0 });
      continue;
    }
    visitNodes(node.children ?? [], files);
  }
}

function normalizeNodes(value: readonly unknown[], depth: number): readonly WorkspaceTreeNode[] {
  if (depth > MAX_TREE_DEPTH) {
    return [];
  }
  const nodes: WorkspaceTreeNode[] = [];
  for (const candidate of value) {
    const record = asRecord(candidate);
    const path = safeRelativePath(record?.path);
    const name = safeName(record?.name);
    const type = record?.type === 'directory' ? 'directory' : record?.type === 'file' ? 'file' : undefined;
    if (!path || !name || !type) {
      continue;
    }
    const sizeBytes = readNonNegativeInteger(record?.sizeBytes);
    const children = type === 'directory' && Array.isArray(record?.children) ? normalizeNodes(record.children, depth + 1) : undefined;
    nodes.push({ path, name, type, ...(type === 'file' ? { sizeBytes } : {}), ...(children ? { children } : {}) });
  }
  return nodes;
}

function normalizeSearchMatches(value: readonly unknown[]): readonly WorkspaceFileSearchMatch[] {
  const matches: WorkspaceFileSearchMatch[] = [];
  for (const candidate of value) {
    const record = asRecord(candidate);
    const path = safeRelativePath(record?.path);
    const line = readPositiveInteger(record?.line);
    const column = readPositiveInteger(record?.column);
    if (!path || line === null || column === null || typeof record?.text !== 'string') continue;
    matches.push({ path, line, column, text: record.text.slice(0, 16_384) });
    if (matches.length >= MAX_SEARCH_RESULTS) break;
  }
  return matches;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!path || path.startsWith('/') || /^[a-z]:/iu.test(path) || path.split('/').some((part) => part === '..') || /[\u0000-\u001f\u007f]/u.test(path)) {
    return null;
  }
  return path;
}

function safeDirectory(value: unknown): string {
  return safeRelativePath(value) ?? '';
}

function safeName(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : null;
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
