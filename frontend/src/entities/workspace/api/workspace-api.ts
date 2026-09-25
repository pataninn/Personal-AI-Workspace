import { getJson } from '@/shared/api';
import type { WorkspaceFileCandidate, WorkspaceTreeNode, WorkspaceTreeResponse } from '@/entities/workspace/model/types';

const PROJECTS_PATH = '/api/v1/projects';
const MAX_TREE_DEPTH = 6;
const MAX_FILES = 500;

export function getWorkspaceTree(projectId: string, depth = 4): Promise<WorkspaceTreeResponse> {
  const boundedDepth = Math.max(0, Math.min(MAX_TREE_DEPTH, Math.floor(depth)));
  return getJson<unknown>(`${PROJECTS_PATH}/${encodeURIComponent(projectId)}/files/tree?depth=${boundedDepth}`).then((value) => normalizeWorkspaceTree(value));
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
